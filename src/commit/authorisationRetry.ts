// RETRYING AN AUTHORISATION THAT FAILED AT DISPATCH.
//
// The rule that produces these rows is the one the phase brief states twice:
// a stranded driver does not wait for a card to clear, so an authorisation
// failing at commit means the job dispatches ANYWAY and the payment is left at
// PENDING_AUTHORISATION. That is a deliberate, visible, degraded state — and a
// degraded state with nobody coming back for it is just a lost charge.
//
// THIS IS THE COMING BACK. A sweep on the cleanup schedule finds them and
// asks the provider again.
//
// WHY A SWEEP AND NOT A RETRYING QUEUE JOB. The failure this recovers from is
// usually the provider being down, which is a condition that lasts minutes and
// affects every job at once. A per-payment retry job would mean a thundering
// herd against a gateway that is already unwell; one periodic pass over
// whatever is outstanding paces itself for free and needs no new queue.
//
// DECLINED IS NOT RETRIED — or rather, it is, and that is a known weakness
// recorded in this phase's log. The provider distinguishes DECLINED (they
// answered no; a retry gets the same answer) from UNREACHABLE (we never heard;
// a retry is the only way to find out), but `payments.status` does not record
// which it was, so this sweep cannot tell them apart. The idempotency key
// makes retrying harmless; it is wasteful rather than wrong.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import { authoriseCallout } from './payments.js';
import type { PaymentProvider } from '../payments/provider.js';

// Enough to clear a backlog from a short outage without holding the cleanup
// transaction open across hundreds of provider calls.
const RETRY_BATCH = 25;

// `jobIds` NARROWS THE SWEEP, and exists for one honest reason: two test files
// each calling a GLOBAL sweep against one shared database steal each other's
// rows — whichever runs first authorises the other's payment, and the loser
// then asserts against a backlog somebody else cleared. Production passes
// nothing and sweeps everything, which is what the cleanup schedule wants.
export async function retryPendingAuthorisations(
  db: PrismaClient,
  options: { provider?: PaymentProvider; jobIds?: string[] } = {},
): Promise<number> {
  const pending = await db.payment.findMany({
    where: {
      status: 'PENDING_AUTHORISATION',
      ...(options.jobIds ? { jobId: { in: options.jobIds } } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: RETRY_BATCH,
    select: { id: true, jobId: true },
  });

  let authorised = 0;
  for (const payment of pending) {
    // `authoriseCallout` already finds the existing row and reuses its
    // idempotency key, so a retry cannot place a second hold — which is the
    // only reason it is safe to call this against a payment we are not certain
    // failed.
    const result = await authoriseCallout(db, { jobId: payment.jobId, provider: options.provider });
    if (result.outcome === 'AUTHORISED') authorised += 1;
  }

  if (pending.length > 0) {
    logger.info(
      { attempted: pending.length, authorised },
      'retried callout authorisations left pending at dispatch',
    );
  }
  return authorised;
}
