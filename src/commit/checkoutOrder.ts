// WHAT "PAY NOW" CHARGES, RIGHT NOW.
//
// Payment is two-stage (src/commit/payments.ts): the callout fee is authorised
// first, so a crew is never sent on a promise, and the approved estimate total
// is captured at completion. When the approved total is larger than what was
// held, completion asks the provider for a SECOND authorisation for the
// difference. With the stub provider that is instant. With Razorpay an
// authorisation only ever happens when the driver completes a checkout — and
// nothing showed the driver a checkout for that difference. So the screen said
// "Callout fee ₹300" while the technician's bill said ₹402, and the ₹102 could
// never be collected: the completion-time capture opened an order nobody saw.
//
// This decides which order the driver's single "Pay now" opens:
//
//   no approved estimate yet           -> the callout fee            (CALLOUT)
//   estimate approved, nothing paid    -> ONE order for the total    (TOTAL)
//   callout already paid, total higher -> an order for the balance   (BALANCE)
//
// The balance order is opened with the SAME idempotency key the completion
// capture uses for its top-up, and its reference is stored on the payment, so
// completion hands it back as `knownOrderRef` and captures what the driver
// already paid instead of asking again.

import type { PrismaClient } from '@prisma/client';
import { authoriseCallout } from './payments.js';
import { approvedPayableFor } from './estimates.js';
import { paymentProvider } from '../payments/stubProvider.js';
import type { PaymentProvider } from '../payments/provider.js';

export type CheckoutPurpose = 'CALLOUT' | 'TOTAL' | 'BALANCE';

export type CheckoutOrder =
  | { status: 'READY'; purpose: CheckoutPurpose; orderRef: string; amountPaise: number; totalPaise: number | null; currency: string }
  | { status: 'ALREADY_PAID' }
  | { status: 'NOTHING_TO_PAY' }
  | { status: 'UNAVAILABLE' };

type PaymentForCheckout = {
  id: string;
  status: string;
  amountPaise: number;
  currency: string;
  gatewayOrderRef: string | null;
  balanceOrderRef: string | null;
};

async function readPayment(db: PrismaClient, jobId: string): Promise<PaymentForCheckout | null> {
  return db.payment.findFirst({
    where: { jobId },
    select: { id: true, status: true, amountPaise: true, currency: true, gatewayOrderRef: true, balanceOrderRef: true },
  });
}

// Nothing paid yet and the bill is now known: replace the callout order with
// one for the whole approved total, so the driver pays once, the amount on the
// technician's bill. The key carries the amount, so a revised estimate opens a
// fresh order rather than reusing one for the old figure.
async function repriceToTotal(
  db: PrismaClient,
  provider: PaymentProvider,
  jobId: string,
  payment: PaymentForCheckout,
  totalPaise: number,
): Promise<CheckoutOrder> {
  if (payment.amountPaise === totalPaise && payment.gatewayOrderRef) {
    return { status: 'READY', purpose: 'TOTAL', orderRef: payment.gatewayOrderRef, amountPaise: totalPaise, totalPaise, currency: payment.currency };
  }
  const opened = await provider.authorise({
    idempotencyKey: `checkout-total-${jobId}-${totalPaise}`,
    amountPaise: totalPaise,
    currency: payment.currency,
    reference: jobId,
  });
  if (opened.outcome !== 'AWAITING_CUSTOMER') return { status: 'UNAVAILABLE' };
  await db.payment.update({
    where: { id: payment.id },
    data: { amountPaise: totalPaise, gatewayOrderRef: opened.orderRef },
  });
  return { status: 'READY', purpose: 'TOTAL', orderRef: opened.orderRef, amountPaise: totalPaise, totalPaise, currency: payment.currency };
}

// The callout is already held and the bill came to more: open (or re-check) the
// balance order. AUTHORISED here means the driver has paid it already.
async function balanceOrder(
  db: PrismaClient,
  provider: PaymentProvider,
  jobId: string,
  payment: PaymentForCheckout,
  totalPaise: number,
): Promise<CheckoutOrder> {
  const balancePaise = totalPaise - payment.amountPaise;
  const result = await provider.authorise({
    idempotencyKey: `complete-auth2-${jobId}`,
    amountPaise: balancePaise,
    currency: payment.currency,
    reference: jobId,
    knownOrderRef: payment.balanceOrderRef ?? undefined,
  });
  if (result.outcome === 'AUTHORISED') return { status: 'ALREADY_PAID' };
  if (result.outcome !== 'AWAITING_CUSTOMER') return { status: 'UNAVAILABLE' };
  if (result.orderRef !== payment.balanceOrderRef) {
    await db.payment.update({ where: { id: payment.id }, data: { balanceOrderRef: result.orderRef } });
  }
  return { status: 'READY', purpose: 'BALANCE', orderRef: result.orderRef, amountPaise: balancePaise, totalPaise, currency: payment.currency };
}

export async function checkoutOrderFor(
  db: PrismaClient,
  jobId: string,
  provider: PaymentProvider = paymentProvider(),
): Promise<CheckoutOrder> {
  await authoriseCallout(db, { jobId, provider });
  const payment = await readPayment(db, jobId);
  if (!payment) return { status: 'NOTHING_TO_PAY' };
  if (payment.status === 'CAPTURED') return { status: 'ALREADY_PAID' };

  const totalPaise = await approvedPayableFor(db, jobId);
  const held = payment.status === 'AUTHORISED';

  if (totalPaise !== null && totalPaise > 0) {
    if (!held && payment.status === 'PENDING_AUTHORISATION') {
      return repriceToTotal(db, provider, jobId, payment, totalPaise);
    }
    if (held && totalPaise > payment.amountPaise) {
      return balanceOrder(db, provider, jobId, payment, totalPaise);
    }
  }

  if (held) return { status: 'ALREADY_PAID' };
  if (!payment.gatewayOrderRef) return { status: 'UNAVAILABLE' };
  return {
    status: 'READY',
    purpose: 'CALLOUT',
    orderRef: payment.gatewayOrderRef,
    amountPaise: payment.amountPaise,
    totalPaise,
    currency: payment.currency,
  };
}
