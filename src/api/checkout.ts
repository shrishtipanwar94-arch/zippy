// THE DRIVER'S CHECKOUT — two endpoints, and the second one is the interesting
// one.
//
//   POST /jobs/:id/checkout           open (or find) the order, and hand the
//                                     browser what Razorpay's widget needs.
//   POST /jobs/:id/checkout/callback  the browser reporting what happened.
//
// THE CALLBACK IS A HINT, NEVER EVIDENCE. Razorpay's widget hands the browser
// an order id, a payment id and a signature; the signature proves the browser is
// quoting a real Razorpay result rather than inventing one, and that is ALL it
// proves. A signature is not a statement about our database, a browser can
// replay an old one, and a driver who closes the tab sends nothing at all. So a
// verified callback does not mark anything paid: it triggers the same
// reconciliation the sweep would have done minutes later. The browser's only
// power is to make us ask sooner.
//
// That is also why the endpoint is safe to call twice, and why losing it
// entirely costs nothing but time.
//
// NO CARD DETAILS PASS THROUGH THIS SERVER. The widget runs on Razorpay's
// origin; this route sees an order id and a key id, and the key SECRET never
// leaves the process.

import { Router } from 'express';
import { z } from 'zod';
import { prismaBase } from '../infra/prismaBase.js';
import { visibleJobId } from './visibleJob.js';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { authenticate, requirePermission } from './middleware/authenticate.js';
import { authoriseCallout } from '../commit/payments.js';
import { checkoutOrderFor } from '../commit/checkoutOrder.js';
import { reconcileJobPayment } from '../commit/paymentReconciliation.js';
import { checkoutKeyId } from '../payments/razorpayProvider.js';
import { verifyCheckoutSignature } from '../payments/razorpaySignature.js';

export const checkoutRouter = Router();


checkoutRouter.post(
  '/jobs/:id/checkout',
  authenticate,
  requirePermission('create', 'payment'),
  async (req, res) => {
    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // WITH RAZORPAY: which order, for how much — the callout, the whole approved
    // bill, or the balance after a callout already paid. See
    // src/commit/checkoutOrder.ts for why one fixed callout order was wrong.
    const keyId = checkoutKeyId();
    if (keyId) {
      const order = await checkoutOrderFor(prismaBase, jobId);
      if (order.status !== 'READY') {
        res.json({ status: order.status });
        return;
      }
      res.json({
        status: 'READY',
        keyId,
        purpose: order.purpose,
        orderRef: order.orderRef,
        amountPaise: order.amountPaise,
        totalPaise: order.totalPaise,
        currency: order.currency,
      });
      return;
    }

    // WITHOUT A CHECKOUT KEY (the stub provider), exactly as before: there is no
    // widget to open, so the answer is only whether anything is owed.
    // IDEMPOTENT BY CONSTRUCTION. `authoriseCallout` finds an existing payment
    // row and reuses its key — so a refresh never opens a second one.
    await authoriseCallout(prismaBase, { jobId });

    const payment = await prismaBase.payment.findFirst({
      where: { jobId },
      select: { status: true, amountPaise: true, gatewayOrderRef: true, currency: true },
    });

    // A fleet job or a covered consumer: no gateway, nothing to pay here, and
    // saying so plainly beats an empty response the page has to guess about.
    if (!payment) {
      res.json({ status: 'NOTHING_TO_PAY' });
      return;
    }
    if (payment.status === 'AUTHORISED' || payment.status === 'CAPTURED') {
      res.json({ status: 'ALREADY_PAID' });
      return;
    }

    // The stub provider has no widget. The job has dispatched regardless —
    // that is invariant 8 — and the sweep will come back for the money.
    res.json({ status: 'UNAVAILABLE' });
  },
);

const callbackSchema = z
  .object({
    orderRef: z.string().min(1),
    paymentRef: z.string().min(1),
    signature: z.string().min(1),
  })
  .strict();

checkoutRouter.post(
  '/jobs/:id/checkout/callback',
  authenticate,
  requirePermission('update', 'payment'),
  async (req, res) => {
    const jobId = await visibleJobId(req.params.id);
    if (!jobId) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const body = callbackSchema.parse(req.body ?? {});

    const keySecret = config.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      res.status(503).json({ error: 'checkout_not_configured' });
      return;
    }
    if (
      !verifyCheckoutSignature({
        orderRef: body.orderRef,
        paymentRef: body.paymentRef,
        signature: body.signature,
        keySecret,
      })
    ) {
      logger.warn({ jobId }, 'a checkout callback arrived with a signature that did not verify');
      res.status(400).json({ error: 'invalid_signature' });
      return;
    }

    // AND NOW GO AND ASK. Nothing the browser said is written down; the
    // gateway's own answer is.
    const outcome = await reconcileJobPayment(prismaBase, jobId);
    res.json({ status: outcome });
  },
);
