// THE ONE PLACE THIS CODEBASE TALKS TO RAZORPAY.
//
// Every call in the adapter goes through `razorpayCall`, and the reason to have
// one function rather than a `fetch` per operation is the three-way answer it
// produces. A gateway can say yes, can say no, or can say nothing at all, and
// the difference between the last two decides whether a retry is worth
// anything — which is the distinction `src/payments/provider.ts` is built
// around.
//
//   OK           a 2xx, and a JSON body.
//   REFUSED      they answered, and the answer was an error. A retry with the
//                same request gets the same error. Their error `code` and
//                `description` are carried through so a caller can tell "this
//                payment is already captured" (fine) from "this order does not
//                exist" (not fine).
//   UNREACHABLE  a timeout, a refused connection, a 5xx, a body that was not
//                JSON. We do not know whether the request landed.
//
// A 429 IS UNREACHABLE, NOT REFUSED. They answered, but the answer was "ask
// again", which is operationally the same as not having heard: the request
// definitively did not take effect and trying again is the correct response.
//
// AUTHENTICATION IS HTTP BASIC — key id as the username, key secret as the
// password. It is Razorpay's documented scheme and it means the secret is on
// every request, which is why nothing here ever logs a header.
//
// THE TRANSPORT IS SWAPPABLE, the same seam `setPaymentProvider` uses and for
// the same reason: Stage 1 of this phase has no keys, and every decision this
// adapter makes — how it reads an error code, how it treats a timeout, how it
// dedupes an order — must be provable in the fast suite against a scripted
// gateway rather than a vendor sandbox.

import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';

export type RazorpayCall = {
  method: 'GET' | 'POST';
  // Path only, from the version onwards: `/v1/orders`.
  path: string;
  body?: Record<string, unknown>;
  // Razorpay accepts an idempotency header on refunds and payouts, and ignores
  // it elsewhere. Sending it where it is accepted is the difference between a
  // retried payout being free and being a second transfer.
  idempotencyHeader?: { name: string; value: string };
};

export type RazorpayResult =
  | { outcome: 'OK'; body: Record<string, unknown> }
  | { outcome: 'REFUSED'; status: number; code: string; description: string }
  | { outcome: 'UNREACHABLE'; reason: string };

// What a transport returns: the status and the raw text, nothing interpreted.
// Interpretation is this file's job so a fake transport in a test cannot
// accidentally implement it differently from the real one.
export type RazorpayTransportResponse = { status: number; text: string };
export type RazorpayTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<RazorpayTransportResponse>;

const fetchTransport: RazorpayTransport = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, text: await response.text() };
};

let transport: RazorpayTransport = fetchTransport;

export function setRazorpayTransport(next: RazorpayTransport): void {
  transport = next;
}

export function resetRazorpayTransport(): void {
  transport = fetchTransport;
}

export function isRazorpayConfigured(): boolean {
  return Boolean(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET);
}

export async function razorpayCall(call: RazorpayCall): Promise<RazorpayResult> {
  const keyId = config.RAZORPAY_KEY_ID;
  const keySecret = config.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    // Not an exception: a missing key is a provider that is not there, which is
    // exactly what UNREACHABLE means, and the caller already handles it.
    return { outcome: 'UNREACHABLE', reason: 'no Razorpay credentials are configured' };
  }

  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
    accept: 'application/json',
  };
  if (call.body) headers['content-type'] = 'application/json';
  if (call.idempotencyHeader) headers[call.idempotencyHeader.name] = call.idempotencyHeader.value;

  // A gateway that never answers must not hold a request open forever — a
  // technician is standing in front of a screen waiting for a capture.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.RAZORPAY_TIMEOUT_MS);

  try {
    const response = await transport(`${config.RAZORPAY_API_BASE_URL}${call.path}`, {
      method: call.method,
      headers,
      body: call.body ? JSON.stringify(call.body) : undefined,
      signal: controller.signal,
    });
    return interpret(call, response);
  } catch (error) {
    // Timeouts, DNS failures, refused connections. We never got an answer.
    const reason = error instanceof Error ? error.message : 'the request failed';
    logger.warn({ path: call.path, reason }, 'razorpay was unreachable');
    return { outcome: 'UNREACHABLE', reason };
  } finally {
    clearTimeout(timer);
  }
}

function interpret(call: RazorpayCall, response: RazorpayTransportResponse): RazorpayResult {
  let parsed: unknown;
  try {
    parsed = response.text.length > 0 ? JSON.parse(response.text) : {};
  } catch {
    return { outcome: 'UNREACHABLE', reason: `a non-JSON response with status ${response.status}` };
  }
  const body = isRecord(parsed) ? parsed : {};

  if (response.status >= 200 && response.status < 300) {
    return { outcome: 'OK', body };
  }

  // Their own words, so a caller can branch on the specific refusal rather than
  // on a status code that means six things.
  const error = isRecord(body.error) ? body.error : {};
  const code = typeof error.code === 'string' ? error.code : 'UNKNOWN';
  const description =
    typeof error.description === 'string' ? error.description : `status ${response.status}`;

  if (response.status === 429 || response.status >= 500) {
    logger.warn({ path: call.path, status: response.status, code }, 'razorpay could not answer');
    return { outcome: 'UNREACHABLE', reason: `${code}: ${description}` };
  }

  // A REJECTED CREDENTIAL IS NOT A GATEWAY OUTAGE, and telling them apart is
  // worth four lines. Every caller collapses a refused LOOKUP into UNREACHABLE
  // — correctly, because a lookup that was refused leaves us genuinely unable
  // to say what the gateway holds — and the operator-visible consequence is a
  // sweep reporting "unreachable" every five minutes while somebody checks the
  // network. A 401 says the keys are wrong, retrying will not fix it, and a
  // person has to go and change something. Logged loudly rather than turned
  // into a new outcome: the DECISION is unchanged, only what an operator is
  // told about it (invariant 8 — a degraded state has to be visible, and a
  // mislabelled one barely is).
  if (response.status === 401 || response.status === 403) {
    logger.error(
      { path: call.path, status: response.status, code },
      'razorpay rejected our credentials — check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET',
    );
  }

  return { outcome: 'REFUSED', status: response.status, code, description };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
