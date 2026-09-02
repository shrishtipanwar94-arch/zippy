// POST /webhooks/razorpay — the one route in this codebase with no
// authentication, because the caller is not a user.
//
// THE ORDER OF OPERATIONS IS THE SECURITY. Read the raw bytes, check the HMAC,
// and only then parse. Parsing first would mean this server deserialising
// arbitrary JSON from anybody who found the URL — and worse, it would tempt a
// future edit into looking something up "just to log it" before the signature
// was checked, which is how an unauthenticated endpoint becomes a lookup oracle.
// Nothing here touches the database until the signature has passed.
//
// EXPRESS.RAW, NOT EXPRESS.JSON, and this router is mounted BEFORE the global
// JSON parser in src/api/app.ts. `JSON.parse` followed by `JSON.stringify` does
// not round-trip byte for byte — key order, whitespace and number formatting all
// move — so a signature computed over a re-serialised body would fail against a
// perfectly good payload. The bytes as they arrived are the only thing worth
// hashing.
//
// EVERY VERIFIED DELIVERY GETS A 200, including ones we did nothing about.
// Razorpay retries anything else, and an event about a payment we cannot match
// is not a failure to be retried — it is stored as UNMATCHED and handed to the
// reconciliation worker. A 500 is reserved for "our database was not available",
// which IS worth retrying.
//
// NOT CONFIGURED IS 503, NOT 200. With no webhook secret there is nothing to
// verify against, and a 200 would tell Razorpay their delivery was accepted when
// it was thrown away.

import express, { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { prismaBase } from '../infra/prismaBase.js';
import { verifyWebhookSignature } from '../payments/razorpaySignature.js';
import { parseWebhook } from '../payments/razorpayEvents.js';
import { applyRazorpayWebhook } from '../commit/razorpayWebhook.js';

export const webhooksRouter = Router();

webhooksRouter.post(
  '/webhooks/razorpay',
  express.raw({ type: '*/*', limit: '1mb' }),
  async (req, res) => {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      res.status(503).json({ error: 'webhooks_not_configured' });
      return;
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const signature = headerValue(req.headers['x-razorpay-signature']);

    if (!verifyWebhookSignature({ rawBody, signature, secret })) {
      // Nothing has been parsed, nothing has been looked up, and the response
      // says only that the signature was wrong — not which part of it.
      logger.warn({ bytes: rawBody.length }, 'rejected an unsigned or mis-signed razorpay webhook');
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    // THEIR EVENT ID IS THE IDEMPOTENCY KEY, and it arrives in a header rather
    // than the body. A delivery without one cannot be deduped, so it is refused
    // rather than applied — an event we could not recognise on a redelivery
    // would be applied twice.
    const eventId = headerValue(req.headers['x-razorpay-event-id']);
    if (!eventId) {
      res.status(400).json({ error: 'missing_event_id' });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }

    const parsed = parseWebhook(body);
    if (!parsed) {
      res.status(400).json({ error: 'unrecognised_event' });
      return;
    }

    const outcome = await applyRazorpayWebhook(prismaBase, {
      eventId,
      parsed,
      payload: body as Prisma.InputJsonValue,
    });

    res.status(200).json({ received: true, outcome });
  },
);

function headerValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header[0];
  return header;
}
