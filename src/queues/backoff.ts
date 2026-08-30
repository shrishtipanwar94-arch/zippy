// EXPONENTIAL BACKOFF, CAPPED.
//
// BullMQ's built-in `backoff: { type: 'exponential', delay }` doubles forever:
// attempt 20 would wait over a year. A cap matters for a real reason, not
// tidiness — an uncapped backoff on a queue an operator is watching looks
// exactly like a hung job, because "will retry in 400 days" and "will never
// retry" are indistinguishable from the outside.
//
// `type: 'custom'` hands control to this function, which every Worker in
// runWorkers.ts is given via `settings.backoffStrategy`.

import type { BackoffStrategy } from 'bullmq';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60 * 1_000; // 5 minutes

export const cappedExponentialBackoff: BackoffStrategy = (attemptsMade: number) => {
  const delay = BASE_DELAY_MS * 2 ** (attemptsMade - 1);
  return Math.min(delay, MAX_DELAY_MS);
};

// The retry budget every processor gets, and the option object that spends it.
// A fixed, shared value rather than one per queue: retry policy is an
// infrastructure concern, not a business one, and a queue that genuinely needs
// a different budget is a decision worth making explicitly, not a default
// nobody chose.
export const MAX_ATTEMPTS = 5;

export const RETRY_JOB_OPTIONS = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'custom' as const },
};
