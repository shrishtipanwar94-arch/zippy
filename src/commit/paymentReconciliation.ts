// THE RECONCILIATION SWEEP — the only thing in this codebase that can close a
// gap between what Razorpay did and what this database recorded.
//
// See src/payments/reconciliationDecision.ts for WHY a webhook is not enough.
// This file is the doing: find every payment we hold in a non-terminal state
// that has not moved for a while, ask the gateway what it believes, and make
// our side match.
//
// STALENESS IS THE FILTER, not "everything non-terminal". A payment created
// forty seconds ago and still PENDING is a driver part-way through a checkout
// screen, not a lost write, and chasing it would spend a gateway call to learn
// nothing. `RECONCILIATION_STALE_AFTER_MINUTES` is where the line sits.
//
// IT ONLY EVER MOVES A PAYMENT FORWARD. A divergence in the other direction —
// our row claiming money the gateway says it never took — is escalated to an
// operator rather than corrected, because the correction would be to un-record
// a capture, and a system that can quietly do that is worse than one that
// occasionally needs a human.
//
// SCOPED CALLS FOR TESTS, unscoped in production. `jobIds` and `references`
// exist for the reason `retryPendingAuthorisations` grew the same option: this
// sweeps the whole database, `zippy_test` is shared, and a suite asserting on a
// backlog another suite's sweep just cleared fails for a reason that has
// nothing to do with the code.

import type { PaymentStatus, PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { fetchOrderState, fetchPaymentState } from '../payments/razorpayOrders.js';
import type { GatewayStateResult } from '../payments/razorpayOrders.js';
import { reconciliationDecisionFor } from '../payments/reconciliationDecision.js';
import { fetchPayout } from '../payments/razorpayPayouts.js';
import { runPublishingTransaction } from '../realtime/transaction.js';
import { appendJobEvent } from '../intake/events.js';
import { advancePaymentTo, recordPaymentEvent } from './gatewayTransition.js';
import { closeBatchIfFinished, settlePayoutOnLedger } from './payoutExecution.js';

// Enough to clear a backlog from a short outage; small enough that one pass
// cannot spend minutes inside a gateway that has gone slow.
const SWEEP_LIMIT = 25;

export type ReconciliationSummary = {
  examined: number;
  advanced: number;
  awaitingCustomer: number;
  escalated: number;
  unreachable: number;
};

export async function reconcilePayments(
  db: PrismaClient,
  options: { jobIds?: string[] } = {},
): Promise<ReconciliationSummary> {
  const staleBefore = new Date(Date.now() - config.RECONCILIATION_STALE_AFTER_MINUTES * 60_000);

  const candidates = await db.payment.findMany({
    where: {
      status: { in: ['PENDING', 'PENDING_AUTHORISATION', 'AUTHORISED'] },
      updatedAt: { lt: staleBefore },
      // Nothing to ask about a payment the gateway has never heard of. A row
      // with neither reference never reached Razorpay at all, and the
      // authorisation retry sweep owns that case.
      OR: [{ gatewayOrderRef: { not: null } }, { externalRef: { not: null } }],
      ...(options.jobIds ? { jobId: { in: options.jobIds } } : {}),
    },
    orderBy: { updatedAt: 'asc' },
    take: SWEEP_LIMIT,
    select: {
      id: true,
      jobId: true,
      status: true,
      amountPaise: true,
      externalRef: true,
      gatewayOrderRef: true,
    },
  });

  const summary: ReconciliationSummary = {
    examined: candidates.length,
    advanced: 0,
    awaitingCustomer: 0,
    escalated: 0,
    unreachable: 0,
  };

  for (const payment of candidates) {
    const outcome = await reconcileOnePayment(db, payment);
    if (outcome === 'ADVANCED') summary.advanced += 1;
    if (outcome === 'AWAITING_CUSTOMER') summary.awaitingCustomer += 1;
    if (outcome === 'ESCALATED') summary.escalated += 1;
    if (outcome === 'UNREACHABLE') summary.unreachable += 1;
  }

  if (summary.examined > 0) logger.info(summary, 'payment reconciliation pass');
  return summary;
}

// ONE PAYMENT, ASKED ABOUT AND SETTLED. Split out because there are two callers
// with different triggers and the same logic: this sweep, on a timer, and the
// driver's browser reporting back from a checkout (src/api/checkout.ts) — which
// is a HINT, never evidence. A browser can claim anything; what makes the claim
// safe to act on is that acting on it means asking the gateway.
export type ReconcileOutcome =
  | 'ADVANCED'
  | 'AWAITING_CUSTOMER'
  | 'ESCALATED'
  | 'UNREACHABLE'
  | 'NOTHING';

type ReconcilablePayment = {
  id: string;
  jobId: string;
  status: PaymentStatus;
  amountPaise: number;
  externalRef: string | null;
  gatewayOrderRef: string | null;
};

export async function reconcileOnePayment(
  db: PrismaClient,
  payment: ReconcilablePayment,
): Promise<ReconcileOutcome> {
  // The payment ref is the more specific question, so it is asked when we have
  // one; the order is the fallback, and the only one available for a payment
  // nobody has completed a checkout against.
  if (!payment.externalRef && !payment.gatewayOrderRef) return 'NOTHING';
  const state: GatewayStateResult = payment.externalRef
    ? await fetchPaymentState(payment.externalRef)
    : await fetchOrderState(payment.gatewayOrderRef!);

  if (state.outcome === 'UNREACHABLE') return 'UNREACHABLE';

  const decision = reconciliationDecisionFor({ local: payment.status, gateway: state.state });
  if (decision.action === 'AWAIT_CUSTOMER') return 'AWAITING_CUSTOMER';
  if (decision.action === 'NOTHING') return 'NOTHING';
  if (decision.action === 'ESCALATE') {
    await recordDivergence(db, payment.id, payment.jobId, decision.reason);
    return 'ESCALATED';
  }

  await runPublishingTransaction(db, async (tx) => {
    await advancePaymentTo(tx, {
      paymentId: payment.id,
      jobId: payment.jobId,
      heldPaise: payment.amountPaise,
      to: decision.to,
      paymentRef: state.state.paymentRef,
      amountPaise: state.state.capturedPaise ?? state.state.amountPaise,
      eventType: 'reconciliation',
      source: 'reconciliation',
    });
    await recordPaymentEvent(tx, payment.id, 'RECONCILED', {
      source: 'reconciliation',
      to: decision.to,
      reason: decision.reason,
    });
  });
  logger.warn(
    { paymentId: payment.id, jobId: payment.jobId, to: decision.to },
    'reconciliation found a payment the gateway had moved and this database had not',
  );
  return 'ADVANCED';
}

// The whole sweep, narrowed to one job. What the checkout callback calls.
export async function reconcileJobPayment(
  db: PrismaClient,
  jobId: string,
): Promise<ReconcileOutcome> {
  const payment = await db.payment.findFirst({
    where: { jobId },
    select: {
      id: true,
      jobId: true,
      status: true,
      amountPaise: true,
      externalRef: true,
      gatewayOrderRef: true,
    },
  });
  if (!payment) return 'NOTHING';
  return reconcileOnePayment(db, payment);
}

// A DEGRADED STATE MADE VISIBLE, and nothing more (invariant 8). The row is not
// corrected: an operator decides what a payment we recorded and the gateway
// denies actually means.
async function recordDivergence(
  db: PrismaClient,
  paymentId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  await runPublishingTransaction(db, async (tx) => {
    await recordPaymentEvent(tx, paymentId, 'GATEWAY_DIVERGENCE', { reason });
    await appendJobEvent(tx, {
      jobId,
      eventType: 'PAYMENT_GATEWAY_DIVERGENCE',
      payload: { paymentId, reason },
    });
  });
  logger.error({ paymentId, jobId, reason }, 'the database and the gateway disagree about a payment');
}

// ---------------------------------------------------------------------------
// PAYOUTS STUCK IN FLIGHT.
//
// The same argument, in the other direction: a payout accepted as `queued`
// becomes `processed` minutes later, and the webhook that says so is exactly as
// droppable as the payment ones. A payout left at SENT with nobody asking is a
// technician who was paid and a ledger that never recorded it.

export type PayoutReconciliationSummary = { examined: number; settled: number; returned: number };

export async function reconcilePayouts(
  db: PrismaClient,
  options: { references?: string[] } = {},
): Promise<PayoutReconciliationSummary> {
  const staleBefore = new Date(Date.now() - config.RECONCILIATION_STALE_AFTER_MINUTES * 60_000);

  const inFlight = await db.payout.findMany({
    where: {
      status: 'SENT',
      providerRef: { not: null },
      sentAt: { lt: staleBefore },
      ...(options.references ? { batch: { reference: { in: options.references } } } : {}),
    },
    take: SWEEP_LIMIT,
    select: {
      id: true,
      providerRef: true,
      amountPaise: true,
      technicianId: true,
      batchId: true,
      batch: { select: { reference: true } },
    },
  });

  let settled = 0;
  let returned = 0;

  for (const payout of inFlight) {
    const state = await fetchPayout(payout.providerRef!);
    if (state.outcome === 'UNREACHABLE' || state.progress === 'IN_FLIGHT') continue;

    if (state.progress === 'PROCESSED') {
      await db.payout.update({
        where: { id: payout.id },
        data: { status: 'PAID', failureReason: null },
      });
      if (payout.batch) {
        await settlePayoutOnLedger(db, {
          reference: payout.batch.reference,
          technicianId: payout.technicianId,
          amountPaise: payout.amountPaise,
        });
      }
      settled += 1;
    } else {
      // It came back. The technician is still owed and the accrual still
      // stands, so nothing moves on the ledger — the row simply goes back into
      // the queue the next run works through.
      await db.payout.update({
        where: { id: payout.id },
        data: { status: 'PENDING', providerRef: null, failureReason: state.failureReason ?? 'the transfer failed' },
      });
      returned += 1;
    }

    if (payout.batchId && payout.batch) {
      await closeBatchIfFinished(db, payout.batchId, payout.batch.reference);
    }
  }

  return { examined: inFlight.length, settled, returned };
}
