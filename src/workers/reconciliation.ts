// THE RECONCILIATION SWEEP, ON THE CLEANUP SCHEDULE.
//
// Runs beside the existing five-minute sweep rather than on a queue of its own,
// for the reason cleanup.ts already gives about the payout run: this is
// periodic work with nobody waiting on the answer, and a fifth queue to run one
// function every five minutes would be a fifth Worker and a fifth Redis
// connection for nothing.
//
// OUTSIDE ANY DATABASE TRANSACTION, deliberately, and the same rule the
// authorisation retry follows: this talks to a payment gateway over the
// network, and holding a Postgres transaction open across a series of calls to
// a vendor that may be timing out is how a slow supplier becomes a database
// incident.
//
// NOT WRAPPED IN `runIdempotently` EITHER. Re-running it is already safe —
// every decision it makes is derived from what the gateway says right now, and
// the transitions it writes are the same ones a webhook would write — and a
// sweep that skipped itself after a crash would leave a lost write undiscovered
// for a full interval for no reason.
//
// A NO-OP WITH NO CREDENTIALS. Without Razorpay configured every payment in the
// database belongs to the stub, whose refs mean nothing to any gateway, and
// asking about them would be a pile of failed calls that prove nothing.

import type { Job } from 'bullmq';
import { prismaBase } from '../infra/prismaBase.js';
import { isRazorpayConfigured } from '../payments/razorpayClient.js';
import { reconcilePayments, reconcilePayouts } from '../commit/paymentReconciliation.js';

export async function runReconciliationSweep(job: Job): Promise<void> {
  if (!isRazorpayConfigured()) return;

  const payments = await reconcilePayments(prismaBase);
  const payouts = await reconcilePayouts(prismaBase);

  if (payments.examined === 0 && payouts.examined === 0) return;
  await job.log(
    `reconciled ${payments.examined} payments (${payments.advanced} advanced, ` +
      `${payments.escalated} diverged, ${payments.unreachable} unreachable) and ` +
      `${payouts.examined} in-flight payouts (${payouts.settled} settled, ${payouts.returned} returned)`,
  );
}
