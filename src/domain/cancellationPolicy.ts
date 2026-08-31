// WHAT A CANCELLATION COSTS.
//
// A PURE FUNCTION, WITH NO DATABASE, AND THAT IS THE POINT. The brief is
// explicit that this must be unit-testable without one, and the reason is
// commercial rather than technical: this is the rule a customer argues with.
// "You charged me for a van I cancelled before it left" is a sentence somebody
// will say, and the answer has to be a function you can read aloud and a test
// you can point at — not behaviour distributed across a saga, a route and a
// worker.
//
// FOUR STAGES, AND THE LINE IS WHETHER SOMEBODY IS OUT OF THE DEPOT.
//
//   before the technician accepts   nothing has been spent. Void, no charge.
//   accepted, not yet en route      they said yes and are still at base.
//                                   Void, no charge — an accept is not a cost.
//   en route                        a van is on the road and that road time is
//                                   real whether or not it arrives. The callout
//                                   fee, and nothing else.
//   on scene                        they arrived and may have opened parts.
//                                   Callout fee plus whatever was consumed.
//
// The second row is the one worth defending. It would be easy to charge from
// the moment a technician accepts — the system did work, a unit was held, a
// plan was committed. But nothing was SPENT: the van has not moved, and a
// driver who changes their mind in the thirty seconds after an accept has cost
// the business a solver run. Charging for that is the kind of fee that ends up
// in a screenshot on social media.
//
// PARTS ARE CHARGED ONLY WHEN CONSUMED, never when merely carried. A van that
// arrives with an alternator on board and drives away with it still on board
// has consumed nothing, and the caller passes zero.

import type { JobStatus } from '@prisma/client';
import type { Paise } from './money.js';

export const CANCELLATION_STAGES = [
  'BEFORE_ACCEPTANCE',
  'ACCEPTED_NOT_EN_ROUTE',
  'EN_ROUTE',
  'ON_SCENE',
] as const;

export type CancellationStage = (typeof CANCELLATION_STAGES)[number];

export type CancellationQuery = {
  stage: CancellationStage;
  calloutFeePaise: Paise;
  // What the technician actually opened, fitted or poured in. Zero unless
  // somebody is on scene and has used something.
  partsConsumedPaise: Paise;
};

export type CancellationOutcome = {
  // VOID releases the authorisation and takes nothing. CAPTURE takes exactly
  // `chargePaise` — which may still be zero if the fee itself is zero, and the
  // two are not the same act: a void tells the customer's bank to let the hold
  // go, and a zero capture would leave it sitting there.
  action: 'VOID' | 'CAPTURE';
  chargePaise: Paise;
  // The components, so an invoice line can say what the charge was FOR rather
  // than presenting a customer with one number to disagree with.
  calloutFeePaise: Paise;
  partsConsumedPaise: Paise;
  reason: string;
};

export function cancellationCharge(query: CancellationQuery): CancellationOutcome {
  const nothing = {
    action: 'VOID' as const,
    chargePaise: 0,
    calloutFeePaise: 0,
    partsConsumedPaise: 0,
  };

  switch (query.stage) {
    case 'BEFORE_ACCEPTANCE':
      return { ...nothing, reason: 'cancelled before a technician accepted the job' };

    case 'ACCEPTED_NOT_EN_ROUTE':
      // An accept is not a cost. Nothing has left the depot.
      return { ...nothing, reason: 'cancelled before the technician set off' };

    case 'EN_ROUTE':
      return {
        action: 'CAPTURE',
        chargePaise: query.calloutFeePaise,
        calloutFeePaise: query.calloutFeePaise,
        partsConsumedPaise: 0,
        reason: 'cancelled while the technician was on the way',
      };

    case 'ON_SCENE':
      return {
        action: 'CAPTURE',
        chargePaise: query.calloutFeePaise + query.partsConsumedPaise,
        calloutFeePaise: query.calloutFeePaise,
        partsConsumedPaise: query.partsConsumedPaise,
        reason: 'cancelled after the technician arrived',
      };
  }
}

// ---------------------------------------------------------------------------
// WHERE A JOB IS, IN THE POLICY'S VOCABULARY.
//
// Kept here rather than at the call site so the mapping from a job's state to
// a commercial stage is part of the rule somebody argues with, not an
// interpretation a route made up. Still pure — it takes a status, not a job.
//
// Null means the job is not cancellable: it is already finished or already
// cancelled, and a policy answer for it would be a fiction.
export function cancellationStageFor(status: JobStatus): CancellationStage | null {
  switch (status) {
    case 'DRAFT':
    case 'INTAKE':
    case 'PLANNED':
    case 'OFFERED':
      return 'BEFORE_ACCEPTANCE';

    case 'COMMITTED':
      return 'ACCEPTED_NOT_EN_ROUTE';

    case 'EN_ROUTE':
      return 'EN_ROUTE';

    // Everything from arrival onward is on scene, INCLUDING the two waiting
    // states. A job paused for an approval or for a workshop still has a
    // technician standing next to the car, and the customer's clock does not
    // stop because ours did.
    case 'ON_SITE':
    case 'DIAGNOSING':
    case 'WORKING':
    case 'AWAITING_APPROVAL':
    case 'AWAITING_DESTINATION':
    case 'TOWING':
      return 'ON_SCENE';

    case 'RESOLVED':
    case 'CANCELLED':
    case 'UNSERVICEABLE':
      return null;
  }
}
