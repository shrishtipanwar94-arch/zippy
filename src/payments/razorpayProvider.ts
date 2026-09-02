// THE RAZORPAY ADAPTER — Phase 15c's PaymentProvider, implemented against a
// real gateway. TEST MODE ONLY; src/infra/config.ts refuses a live key at
// startup, so "this never moves real money" is a validation rule rather than a
// promise in a README.
//
// THE SHAPE MISMATCH THIS FILE ABSORBS, and it is the whole reason an adapter
// is more than a rename. The domain says "authorise": put a hold on the
// customer's money, now, and tell me whether you did. Razorpay cannot do that.
// It opens an ORDER, and the money is only held once the CUSTOMER completes a
// checkout — on their phone, some minutes later, or never.
//
//   authorise()  ensures an order exists and reports what has happened against
//                it. AWAITING_CUSTOMER when nobody has paid yet, AUTHORISED
//                once somebody has. The second answer is what makes the
//                existing retry sweep double as an authorisation reconciler for
//                free: it calls authorise() again, and this same path notices
//                the driver paid ten minutes ago.
//   capture()    POST /payments/:id/capture. Once per payment, all or part.
//   void()       Razorpay has no void endpoint — see voidAuthorisation.
//   refund()     POST /payments/:id/refund, with their idempotency header.
//
// IDEMPOTENCY IS DONE THREE DIFFERENT WAYS, because the vendor offers three:
//   ORDERS   no header at all, and no usable lookup either — Stage 2 measured
//            their order list filtered by receipt returning nothing for an
//            order that had just been created with that receipt. So the
//            database answers instead: `payments.gateway_order_ref` is passed
//            back in as `knownOrderRef` and an order is opened only when we
//            hold no reference to one. Invariant 1, applied to a vendor.
//   CAPTURE  naturally once-only. A second attempt is refused with "already
//            been captured", which we read as success rather than an error —
//            the state that refusal describes is the state we wanted.
//   REFUND   X-Payment-Idempotency-Key, which they honour directly.
//
// NO CARD DETAILS EVER REACH THIS PROCESS. The customer types their card into
// Razorpay's own checkout, on Razorpay's origin; this server sees an order id
// and a payment id and nothing else. That is not a policy this file follows, it
// is the only thing the API makes possible.

import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { razorpayCall, readNumber, readString } from './razorpayClient.js';
import { createOrder, fetchOrderState, fetchPaymentState } from './razorpayOrders.js';
import type {
  AuthoriseRequest,
  AuthoriseResult,
  CaptureRequest,
  CaptureResult,
  PaymentProvider,
  RefundRequest,
  RefundResult,
  VoidRequest,
  VoidResult,
} from './provider.js';

// Razorpay releases an authorisation it never captures after five days. Not a
// number this project chooses — it is theirs — and it is reported to the caller
// rather than enforced here.
const AUTHORISATION_TTL_MS = 5 * 24 * 60 * 60 * 1000;

export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';

  async authorise(request: AuthoriseRequest): Promise<AuthoriseResult> {
    // OUR OWN ROW DECIDES WHETHER AN ORDER EXISTS, not a query against the
    // vendor. See `knownOrderRef` in src/payments/provider.ts for the Stage 2
    // measurement that produced this rule.
    let orderRef = request.knownOrderRef ?? null;
    if (!orderRef) {
      const created = await createOrder({
        amountPaise: request.amountPaise,
        currency: request.currency,
        receipt: request.idempotencyKey,
        jobId: request.reference,
      });
      if (created.outcome === 'UNREACHABLE') {
        return { outcome: 'UNREACHABLE', reason: created.reason };
      }
      if (created.outcome === 'REFUSED') return { outcome: 'DECLINED', reason: created.reason };
      orderRef = created.orderRef;
    }

    // WHAT HAS HAPPENED AGAINST THIS ORDER SINCE. On a first call the answer is
    // always "nothing"; on a retry it is how we discover a checkout completed
    // while no webhook reached us.
    const state = await fetchOrderState(orderRef);
    if (state.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: state.reason };

    const paymentRef = state.state.paymentRef;
    if ((state.state.status === 'AUTHORISED' || state.state.status === 'CAPTURED') && paymentRef) {
      return {
        outcome: 'AUTHORISED',
        externalRef: paymentRef,
        expiresAt: new Date(Date.now() + AUTHORISATION_TTL_MS),
      };
    }
    if (state.state.status === 'FAILED') {
      // Their card was declined. The order stays open and they may try again,
      // so this is not terminal for the order — but it IS an answer, and
      // DECLINED is the outcome meaning "asking again right now changes
      // nothing".
      return { outcome: 'DECLINED', reason: 'the customer’s payment attempt failed' };
    }

    return {
      outcome: 'AWAITING_CUSTOMER',
      orderRef,
      reason: 'the order is open and the customer has not completed checkout',
    };
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    const result = await razorpayCall({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(request.authorisationRef)}/capture`,
      body: { amount: request.amountPaise, currency: 'INR' },
    });

    if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
    if (result.outcome === 'OK') {
      return {
        outcome: 'CAPTURED',
        externalRef: readString(result.body, 'id') ?? request.authorisationRef,
      };
    }

    // A SECOND CAPTURE IS NOT A FAILURE. Razorpay refuses it, and the state that
    // refusal describes is the state we were trying to reach — so we confirm
    // rather than report a failure to a caller that would then flag a completed
    // job as unpaid.
    if (describesAlreadyCaptured(result.description)) {
      const confirmed = await fetchPaymentState(request.authorisationRef);
      if (confirmed.outcome === 'OK' && confirmed.state.status === 'CAPTURED') {
        return { outcome: 'CAPTURED', externalRef: request.authorisationRef };
      }
      return { outcome: 'UNREACHABLE', reason: 'could not confirm an apparently captured payment' };
    }

    return { outcome: 'DECLINED', reason: `${result.code}: ${result.description}` };
  }

  // THERE IS NO VOID ENDPOINT, and this is the honest consequence.
  //
  // Razorpay has two ways money stops being held, and which applies depends on
  // how far the payment got:
  //
  //   AUTHORISED, NOT CAPTURED  they release it themselves after five days.
  //                             There is nothing to call. We record that we
  //                             asked and report VOIDED, because the state the
  //                             caller wanted — "we are not taking this" — is
  //                             the state that results.
  //   ALREADY CAPTURED          the money has moved and only a refund brings it
  //                             back. This is what the optional `refund` on the
  //                             interface exists for: a cancellation whose void
  //                             arrives after a capture a webhook already told
  //                             us about.
  //
  // NEITHER CHANGES A BUSINESS RULE. `settleCancellation` still decides VOID or
  // CAPTURE from the cancellation policy alone; this is only how a release is
  // carried out against this particular vendor.
  async voidAuthorisation(request: VoidRequest): Promise<VoidResult> {
    // An order ref rather than a payment ref means nothing was ever authorised,
    // so there is nothing to release and the caller's intent already holds.
    if (!request.authorisationRef.startsWith('pay_')) return { outcome: 'VOIDED' };

    const state = await fetchPaymentState(request.authorisationRef);
    if (state.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: state.reason };

    if (state.state.status === 'CAPTURED') {
      const refunded = await this.refund({
        idempotencyKey: `${request.idempotencyKey}-refund`,
        paymentRef: request.authorisationRef,
      });
      if (refunded.outcome === 'REFUNDED') return { outcome: 'VOIDED' };
      return {
        outcome: 'UNREACHABLE',
        reason: `could not refund a captured payment: ${refunded.reason}`,
      };
    }

    if (state.state.status === 'AUTHORISED') {
      logger.info(
        { paymentRef: request.authorisationRef },
        'left a razorpay authorisation to lapse; the vendor has no void endpoint',
      );
    }
    return { outcome: 'VOIDED' };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const result = await razorpayCall({
      method: 'POST',
      path: `/v1/payments/${encodeURIComponent(request.paymentRef)}/refund`,
      // Omitting the amount asks for a full refund, which is safer than sending
      // a figure we computed: the amount they captured is the amount they give
      // back.
      body: request.amountPaise === undefined ? {} : { amount: request.amountPaise },
      idempotencyHeader: { name: 'x-payment-idempotency-key', value: request.idempotencyKey },
    });

    if (result.outcome === 'UNREACHABLE') return { outcome: 'UNREACHABLE', reason: result.reason };
    if (result.outcome === 'REFUSED') {
      return { outcome: 'DECLINED', reason: `${result.code}: ${result.description}` };
    }

    const externalRef = readString(result.body, 'id');
    if (!externalRef) return { outcome: 'UNREACHABLE', reason: 'a refund response with no id' };
    return {
      outcome: 'REFUNDED',
      externalRef,
      amountPaise: readNumber(result.body, 'amount') ?? request.amountPaise ?? 0,
    };
  }
}

export const razorpayProvider = new RazorpayProvider();

function describesAlreadyCaptured(description: string): boolean {
  return description.toLowerCase().includes('already been captured');
}

// What the browser needs to open Razorpay's checkout, and nothing more. The key
// SECRET is never part of it — only the publishable key id, which is designed
// to be in a page.
export function checkoutKeyId(): string | null {
  return config.RAZORPAY_KEY_ID ?? null;
}
