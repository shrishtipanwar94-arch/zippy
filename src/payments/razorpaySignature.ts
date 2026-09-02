// HMAC SIGNATURES — the only reason to believe a request came from Razorpay.
//
// WHAT AN HMAC IS, IN ONE PARAGRAPH, because this is the concept this phase
// introduces. Razorpay and this server share a secret string. Before they send
// us anything they hash the exact bytes of the body together with that secret
// and put the hash in a header. We do the same sum with our copy of the secret
// and compare. Anyone can copy the body; nobody can produce the matching hash
// without the secret, so a body whose hash we can reproduce is a body that came
// from someone holding the secret. It authenticates the SENDER and the BYTES at
// once — change one character of the payload and the hash no longer matches.
//
// TWO DIFFERENT SIGNATURES, TWO DIFFERENT SECRETS, and confusing them is the
// classic way to get this wrong:
//
//   WEBHOOK    HMAC(raw request body, RAZORPAY_WEBHOOK_SECRET). Server to
//              server. This is the authoritative channel.
//   CHECKOUT   HMAC("<order_id>|<payment_id>", RAZORPAY_KEY_SECRET). Handed to
//              us by the customer's BROWSER after checkout. It proves the
//              browser is quoting a real Razorpay result, and nothing more —
//              see src/api/checkout.ts for why we still go and ask.
//
// THE RAW BODY, NOT THE PARSED ONE. `JSON.parse` then `JSON.stringify` does not
// round-trip byte for byte — key order, whitespace and number formatting can
// all move — so the hash must be taken over the bytes as they arrived. That is
// why the webhook route mounts `express.raw` and why this function takes a
// Buffer.
//
// TIMING-SAFE COMPARISON. `a === b` on strings returns as soon as two
// characters differ, so the time it takes leaks how much of a guess was right,
// and an attacker who can measure that can find a valid signature one character
// at a time. `timingSafeEqual` always compares the whole buffer.

import { createHmac, timingSafeEqual } from 'node:crypto';

export function razorpayWebhookSignature(rawBody: Buffer, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(input: {
  rawBody: Buffer;
  signature: string | undefined;
  secret: string;
}): boolean {
  if (!input.signature) return false;
  const expected = razorpayWebhookSignature(input.rawBody, input.secret);
  return safeEqualHex(expected, input.signature);
}

// The browser's handshake after a checkout. Razorpay documents the message as
// the order id and the payment id joined by a pipe, and the key SECRET rather
// than the webhook secret signs it.
export function checkoutSignature(input: {
  orderRef: string;
  paymentRef: string;
  keySecret: string;
}): string {
  return createHmac('sha256', input.keySecret)
    .update(`${input.orderRef}|${input.paymentRef}`)
    .digest('hex');
}

export function verifyCheckoutSignature(input: {
  orderRef: string;
  paymentRef: string;
  signature: string | undefined;
  keySecret: string;
}): boolean {
  if (!input.signature) return false;
  const expected = checkoutSignature(input);
  return safeEqualHex(expected, input.signature);
}

// timingSafeEqual throws if the two buffers differ in length, which is itself
// a length oracle — so a wrong-length signature is rejected here, before the
// comparison, and every same-length comparison takes the same time.
function safeEqualHex(expected: string, supplied: string): boolean {
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(supplied, 'utf8'));
}
