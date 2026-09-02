// RAZORPAYX PAYOUTS — sending money OUT, which is a different product from the
// Payments API and behaves differently in three ways worth stating.
//
//   IT HAS A REAL IDEMPOTENCY HEADER. `X-Payout-Idempotency-Key`, honoured by
//   the vendor: the same key twice returns the first payout instead of making a
//   second transfer. This is the one place in the integration where we do not
//   have to invent idempotency ourselves, and it is also the place where
//   getting it wrong would cost the most — a duplicated payout is somebody
//   else's money gone.
//
//   IT IS ASYNCHRONOUS. A payout is accepted as `queued` or `processing` and
//   becomes `processed` some minutes later, or `failed`/`reversed` if the
//   beneficiary's bank rejects it. So "the API returned 200" does not mean the
//   money arrived, and the local status has to distinguish SENT from PAID.
//
//   IT NEVER SENDS A NEGATIVE AMOUNT, because no rail will take money out of
//   somebody's bank account on our say-so. A technician who owes the platform
//   is handled entirely upstream — `payoutDecision` returns CARRY_DEBT, no
//   Payout row is created, and the debt nets against what they earn next.
//   src/commit/payoutExecution.ts refuses a non-positive amount anyway, as the
//   second lock.
//
// NO BANK DETAILS ARE STORED BY THIS PROJECT. A payout goes to a FUND ACCOUNT
// id (`fa_...`) that RazorpayX holds against a contact; the account number and
// IFSC live there, not in `technicians`.

import { config } from '../infra/config.js';
import { razorpayCall, readString } from './razorpayClient.js';

// What a payout is doing right now, normalised out of RazorpayX's seven
// statuses into the three that change what we do.
export type PayoutProgress =
  | 'IN_FLIGHT' // queued, pending, processing — accepted, not landed
  | 'PROCESSED' // the money left and arrived
  | 'FAILED'; // failed, cancelled, reversed — it came back, still owed

export type SendPayoutResult =
  | { outcome: 'ACCEPTED'; payoutRef: string; progress: PayoutProgress }
  // They answered no. The technician is still owed and the row goes back to
  // PENDING with this reason attached.
  | { outcome: 'REFUSED'; reason: string }
  // We never heard. The payout MAY exist on their side, which is exactly why
  // the idempotency key is derived and not random — the retry is safe.
  | { outcome: 'UNREACHABLE'; reason: string };

export async function sendPayout(input: {
  // `payout:<batch reference>:<technician id>`. Derived, never random: a random
  // key on a retry is a new key, and a new key is a second transfer.
  idempotencyKey: string;
  fundAccountRef: string;
  amountPaise: number;
}): Promise<SendPayoutResult> {
  const accountNumber = config.RAZORPAY_PAYOUT_ACCOUNT_NUMBER;
  if (!accountNumber) {
    return { outcome: 'UNREACHABLE', reason: 'no RazorpayX source account is configured' };
  }

  const result = await razorpayCall({
    method: 'POST',
    path: '/v1/payouts',
    body: {
      account_number: accountNumber,
      fund_account_id: input.fundAccountRef,
      amount: input.amountPaise,
      currency: 'INR',
      // IMPS settles in minutes and works around the clock, which suits a daily
      // run that may fire at any hour. NEFT would be cheaper and slower.
      mode: 'IMPS',
      purpose: 'payout',
      // Rather than being rejected outright, a payout waits for the source
      // account to be topped up. A rejection would put the row back to PENDING
      // and have us try the whole batch again against the same empty account.
      queue_if_low_balance: true,
      reference_id: input.idempotencyKey,
      narration: 'Zippy technician payout',
    },
    idempotencyHeader: { name: 'x-payout-idempotency-key', value: input.idempotencyKey },
  });

  if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
  if (result.outcome === 'REFUSED') {
    return { outcome: 'REFUSED', reason: `${result.code}: ${result.description}` };
  }

  const payoutRef = readString(result.body, 'id');
  if (!payoutRef) return { outcome: 'UNREACHABLE', reason: 'a payout response with no id' };
  return {
    outcome: 'ACCEPTED',
    payoutRef,
    progress: progressFrom(readString(result.body, 'status')),
  };
}

export type FetchedPayout =
  | { outcome: 'OK'; progress: PayoutProgress; failureReason: string | null }
  | { outcome: 'UNREACHABLE'; reason: string };

// Asked by the reconciliation worker about a payout stuck at SENT. Same
// argument as for payments: a webhook that never arrives is indistinguishable
// from one that has not arrived yet, and only asking settles it.
export async function fetchPayout(payoutRef: string): Promise<FetchedPayout> {
  const result = await razorpayCall({
    method: 'GET',
    path: `/v1/payouts/${encodeURIComponent(payoutRef)}`,
  });
  if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
  if (result.outcome === 'REFUSED') {
    return { outcome: 'UNREACHABLE', reason: `${result.code}: ${result.description}` };
  }
  return {
    outcome: 'OK',
    progress: progressFrom(readString(result.body, 'status')),
    failureReason: readString(result.body, 'failure_reason'),
  };
}

export function progressFrom(status: string | null): PayoutProgress {
  if (status === 'processed') return 'PROCESSED';
  if (status === 'failed' || status === 'cancelled' || status === 'reversed') return 'FAILED';
  // queued, pending, processing — and anything they add later, which is the
  // safe default: an unknown status is not a reason to declare money sent.
  return 'IN_FLIGHT';
}
