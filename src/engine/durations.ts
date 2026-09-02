// HOW LONG EACH FAULT TAKES — the numbers the expected-time-to-resolution
// term is built from.
//
// This is a hand-written model, exactly like the naive-Bayes rule table in
// src/domain/faultRules.ts, and for the same reason: no historical job data
// exists to fit anything to, and a table an engineer can read and argue with
// beats a fitted curve nobody can explain. Every number below is a plausible
// roadside figure, not a measured one — that is stated here once rather than
// hedged at every line, and it is recorded as a weakness of the phase.
//
// TWO NUMBERS PER FAULT, and the split matters:
//   diagnose — time on site working out what is actually wrong, spent
//              WHETHER OR NOT this technician can then fix it. A technician
//              who cannot fix an EV fault still spends time discovering that.
//   resolve  — time to actually fix it, spent only by someone who can.
// Keeping them separate is what lets the cost function charge a mis-dispatch
// for the diagnosis it wasted without also charging it for a repair that
// never happened.

import type { FaultCode } from '../domain/faults.js';

export type FaultDuration = {
  diagnoseMinutes: number;
  resolveMinutes: number;
};

// Ordered roughly by how long the whole job takes, not alphabetically, so the
// shape of the model is visible at a glance: swaps and deliveries are quick,
// electrical diagnosis is slow, and anything needing a tow is dominated by
// the tow itself.
const FAULT_DURATIONS: Record<FaultCode, FaultDuration> = {
  // Quick, unambiguous, mostly mechanical.
  FLAT_TYRE: { diagnoseMinutes: 3, resolveMinutes: 20 },
  OUT_OF_FUEL: { diagnoseMinutes: 3, resolveMinutes: 10 },
  KEYS_LOCKED_IN: { diagnoseMinutes: 2, resolveMinutes: 15 },
  FLAT_BATTERY: { diagnoseMinutes: 5, resolveMinutes: 10 },

  // A swap rather than a jump — longer, and needs the right battery on board.
  FAILED_BATTERY: { diagnoseMinutes: 8, resolveMinutes: 25 },

  // Electrical faults: the diagnosis is the expensive half.
  ALTERNATOR_FAILURE: { diagnoseMinutes: 15, resolveMinutes: 50 },
  STARTER_MOTOR: { diagnoseMinutes: 15, resolveMinutes: 45 },

  // Programming is fast once the right kit is present; proving which key
  // fault it is takes longer.
  KEY_FAILURE: { diagnoseMinutes: 12, resolveMinutes: 30 },

  // Cooling faults need the engine to cool before anything can be judged.
  ENGINE_OVERHEAT: { diagnoseMinutes: 20, resolveMinutes: 40 },

  BRAKE_FAILURE: { diagnoseMinutes: 15, resolveMinutes: 55 },

  // High-voltage work is slow by procedure, not by difficulty — isolation and
  // safety steps dominate.
  EV_HV_FAULT: { diagnoseMinutes: 25, resolveMinutes: 60 },

  // "Resolve" here means loading it onto a flatbed and moving it, not fixing
  // it — the fault is by definition the one nothing roadside will repair.
  IMMOBILISED_UNKNOWN: { diagnoseMinutes: 15, resolveMinutes: 45 },
};

export function diagnoseMinutes(fault: FaultCode): number {
  return FAULT_DURATIONS[fault].diagnoseMinutes;
}

export function resolveMinutes(fault: FaultCode): number {
  return FAULT_DURATIONS[fault].resolveMinutes;
}

// THE SECOND DISPATCH — what an escalation actually costs.
//
// When the technician on site cannot fix what they find, the job does not
// simply fail: a second, correctly-equipped unit has to be found, offered,
// accepted, and driven out, and only then does the repair start. The build
// plan is emphatic that this must be COMPUTED from those parts rather than
// modelled as one flat penalty number, because a flat penalty says the same
// thing about a mis-dispatched tyre change and a mis-dispatched EV fault,
// and those are not remotely the same mistake.
//
// The two constants below are the parts of a re-dispatch that genuinely do
// NOT vary by fault. What varies — and what makes escalation per-fault — is
// the `resolveMinutes(fault)` the second unit still has to spend once it
// arrives.

// Noticing the first attempt failed, re-planning, offering to another
// technician, and waiting for them to accept. Not travel — purely the
// coordination gap before anyone is moving.
export const REDISPATCH_COORDINATION_MINUTES = 12;

// How long the second unit spends driving. A single modelled figure rather
// than a real route, because the second unit is by definition not chosen yet
// — there is no origin to route from. It is deliberately larger than a
// typical first-dispatch travel time, since the replacement is drawn from
// whoever is left with the right capability rather than from whoever was
// nearest.
export const SECOND_DISPATCH_TRAVEL_MINUTES = 25;

// The whole escalation, per fault. Reads as the sentence the build plan
// describes: wait for a new unit, its travel, its resolve time.
export function escalationMinutes(fault: FaultCode): number {
  return REDISPATCH_COORDINATION_MINUTES + SECOND_DISPATCH_TRAVEL_MINUTES + resolveMinutes(fault);
}

// PHASE 22 — WHAT A WORKSHOP SAYING NO COSTS, in minutes. A destination that
// declines does not need a second UNIT the way a mis-diagnosed fault does —
// the crew and the vehicle are both still there — it needs a second
// DESTINATION, found and offered to. That is coordination
// (REDISPATCH_COORDINATION_MINUTES, the same gap `escalationMinutes` charges
// for noticing a failure and re-planning) plus a drive to wherever the second
// choice turns out to be. No `resolveMinutes` term here: a tow has no
// on-scene repair time of its own to add, and the eventual repair at
// whichever workshop it lands on is a separate, later dispatch this cost
// function does not attempt to price today.
export const DESTINATION_REFUSAL_MINUTES = REDISPATCH_COORDINATION_MINUTES + SECOND_DISPATCH_TRAVEL_MINUTES;
