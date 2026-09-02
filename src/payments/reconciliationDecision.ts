// WHAT TO DO WHEN THE GATEWAY AND THE DATABASE DISAGREE.
//
// THE PROBLEM THIS PHASE EXISTS FOR, stated plainly. Taking money involves two
// writes to two systems that cannot share a transaction: Razorpay's, and ours.
// Between "their API returned success" and "our row says CAPTURED" the process
// can die, the connection can drop, the container can be redeployed. Their
// write happened. Ours did not. Nothing about our database records that money
// moved, and no amount of care in the calling code closes that window — moving
// it earlier or later only changes which of the two writes is the orphan. This
// is the dual-write problem, and it has no local fix.
//
// A WEBHOOK IS NOT THE FIX EITHER, which is the part worth being able to
// defend. A webhook is another delivery over the same unreliable network, from
// a sender who will eventually give up retrying, to a receiver that might be
// down for the whole retry window. It makes the gap SMALLER and more often
// invisible; it cannot make it impossible. Nothing that is itself a message can
// guarantee that two systems agree.
//
// WHAT DOES FIX IT is asking. Periodically, for every payment we hold in a
// non-terminal state, go and read what the gateway believes and make our side
// match. It needs no delivery to succeed, no ordering to hold and no clock to
// be right; it converges from whatever state a crash left behind, and it works
// the first time it runs after a week of the webhook endpoint being broken.
// The webhook is the fast path and the sweep is the correct one.
//
// THIS FILE IS THE DECISION AND NOT THE DOING. A pure function over two plain
// values, so every divergence — including the ones that are awkward to
// reproduce against a real gateway — is an ordinary unit test.

import type { PaymentStatus } from '@prisma/client';
import { localRank, gatewayRank, movesForward } from './gatewayState.js';
import type { GatewayPaymentState } from './gatewayState.js';

export type ReconciliationDecision =
  // The two agree, or the gateway has nothing newer to say.
  | { action: 'NOTHING'; reason: string }
  // The gateway is ahead of us: money moved and our write was lost. Bring the
  // database forward to what they say.
  | { action: 'ADVANCE'; to: GatewayPaymentState['status']; reason: string }
  // Still waiting on a human. Not a divergence — a driver who has not finished
  // checkout yet — so it is named separately from NOTHING to keep the sweep's
  // counters honest about what it found.
  | { action: 'AWAIT_CUSTOMER'; reason: string }
  // WE are ahead of THEM, which no legitimate sequence produces: we recorded
  // taking money the gateway says it never took. Never resolved automatically —
  // the safe direction to move a payment is forward, and this asks to move one
  // back. An operator looks at it.
  | { action: 'ESCALATE'; reason: string };

export function reconciliationDecisionFor(input: {
  local: PaymentStatus;
  gateway: GatewayPaymentState;
}): ReconciliationDecision {
  const gateway = input.gateway.status;

  // A DECLINED ATTEMPT IS NOT A DIVERGENCE. The customer's card was refused and
  // they may try again on the same order in a minute; the payment stays where
  // it is and the retry sweep keeps it visible.
  if (gateway === 'FAILED') {
    return { action: 'NOTHING', reason: 'the customer’s last attempt was declined' };
  }

  // An order with no payment against it. Nobody has done anything wrong; the
  // driver has not paid yet.
  if (gateway === 'CREATED') {
    if (localRank(input.local) > 0) {
      return {
        action: 'ESCALATE',
        reason: 'the database holds an authorisation the gateway has no payment for',
      };
    }
    return { action: 'AWAIT_CUSTOMER', reason: 'the order is open and nobody has paid it' };
  }

  if (movesForward(input.local, gateway)) {
    return {
      action: 'ADVANCE',
      to: gateway,
      reason: `the gateway says ${gateway.toLowerCase()} and the database says ${input.local.toLowerCase()}`,
    };
  }

  if (localRank(input.local) > gatewayRank(gateway)) {
    return {
      action: 'ESCALATE',
      reason: `the database says ${input.local.toLowerCase()} and the gateway only says ${gateway.toLowerCase()}`,
    };
  }

  return { action: 'NOTHING', reason: 'the gateway and the database agree' };
}
