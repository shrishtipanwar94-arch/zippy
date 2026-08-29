// EXTENSION POINTS — the other actors a dispatch system has to cope with.
//
// Nothing calls these yet. They are here because the simulator is a production
// component, not a dev convenience: from Phase 12 the evaluation harness needs
// a technician who takes a realistic time to answer and sometimes declines, a
// diagnosis that changes when someone actually looks at the car, and stock that
// runs out. Retrofitting an autonomous mode late is the failure mode this
// avoids, and each of these is a pure function of a seeded Random so adding the
// call site later cannot make a run non-reproducible.
//
// Each returns a decision. None of them touch the database — the phase that
// wires one up owns the write.

import type { FaultCode } from '../domain/faults.js';
import { FAULT_CODES } from '../domain/faults.js';
import type { Random } from './random.js';

// Phase 12 (the reservation saga) and Phase 13 (re-dispatch) drive this: an
// offer goes out, and the technician takes a while to answer — or does not
// accept at all, and the job has to be re-planned.
export type TechnicianResponse = {
  accepted: boolean;
  latencySeconds: number;
};

const ACCEPT_PROBABILITY = 0.82;
const MIN_RESPONSE_SECONDS = 8;
const MAX_RESPONSE_SECONDS = 95;

export function simulateTechnicianResponse(random: Random): TechnicianResponse {
  const latencySeconds =
    MIN_RESPONSE_SECONDS + random.nextInt(MAX_RESPONSE_SECONDS - MIN_RESPONSE_SECONDS + 1);
  return { accepted: random.chance(ACCEPT_PROBABILITY), latencySeconds };
}

// Phase 13: the technician arrives, looks at the car, and it is not what intake
// thought. This is the event that makes re-dispatch worth building — the
// capability set changes after a unit is already committed.
const DIAGNOSIS_CHANGES_PROBABILITY = 0.18;

export function simulateArrivalDiagnosis(random: Random, intakeFault: FaultCode): FaultCode {
  if (!random.chance(DIAGNOSIS_CHANGES_PROBABILITY)) return intakeFault;

  const alternatives = FAULT_CODES.filter((fault) => fault !== intakeFault);
  return random.pick(alternatives);
}

// Phase 18/19: a part is consumed and the unit's stock falls. Returns the new
// quantity, floored at zero — a unit cannot hold negative stock, and the
// feasibility filter reads this to reject a candidate that cannot finish the
// job in one visit.
export function simulateStockDraw(quantityOnHand: number, quantityUsed: number): number {
  return Math.max(0, quantityOnHand - quantityUsed);
}
