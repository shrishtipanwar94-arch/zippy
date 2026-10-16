// ONE ANSWER SET PER FAULT THE DRIVER SCREEN CAN REPORT.
//
// The driver never names a fault: they pick a complaint and answer questions,
// and the classifier (src/domain/faultRules.ts) turns the answers into a
// probability distribution. So "every fault type" means "an answer set whose
// most likely fault is that one". These were found by running the classifier
// over every combination of answers and keeping, per fault, the set that made
// it most likely — so each is the clearest way a driver can describe it.
//
// KEY_FAILURE IS ABSENT ON PURPOSE: no combination of answers makes it the most
// likely fault (it always loses to a flat battery or a starter motor), so the
// driver screen cannot report it as its own thing. Its capability and part are
// still on crew B, because it can be a contending fault inside other jobs.
//
// Used by scripts/demo-dry-check.ts to prove crew B wins each one.

import type { FaultCode } from '../domain/faults.js';
import type { SymptomPayload } from '../domain/symptoms.js';

export type FaultScenario = { fault: FaultCode; answers: SymptomPayload };

export const FAULT_SCENARIOS: FaultScenario[] = [
  {
    fault: 'FLAT_BATTERY',
    answers: { primaryComplaint: 'WONT_START', engineCranks: 'NO', warningLights: [], unusualSound: 'CLICKING', vehicleMoves: false },
  },
  {
    fault: 'FAILED_BATTERY',
    answers: { primaryComplaint: 'WARNING_LIGHT', engineCranks: 'NO', warningLights: ['BATTERY'], unusualSound: 'NONE', vehicleMoves: false },
  },
  {
    fault: 'ALTERNATOR_FAILURE',
    answers: { primaryComplaint: 'WONT_START', engineCranks: 'YES', warningLights: ['BATTERY'], unusualSound: 'WHINING', vehicleMoves: true },
  },
  {
    fault: 'STARTER_MOTOR',
    answers: { primaryComplaint: 'WONT_START', engineCranks: 'NO', warningLights: ['ENGINE'], unusualSound: 'GRINDING', vehicleMoves: false },
  },
  {
    fault: 'OUT_OF_FUEL',
    answers: { primaryComplaint: 'WONT_START', engineCranks: 'YES', warningLights: ['ENGINE'], unusualSound: 'NONE', vehicleMoves: false },
  },
  {
    fault: 'FLAT_TYRE',
    answers: { primaryComplaint: 'FLAT_TYRE', engineCranks: 'UNSURE', warningLights: [], unusualSound: 'BANG', vehicleMoves: true },
  },
  {
    fault: 'KEYS_LOCKED_IN',
    answers: { primaryComplaint: 'LOCKED_OUT', engineCranks: 'UNSURE', warningLights: [], unusualSound: 'NONE', vehicleMoves: false },
  },
  {
    fault: 'ENGINE_OVERHEAT',
    answers: { primaryComplaint: 'NOISE_OR_SMELL', engineCranks: 'YES', warningLights: ['TEMPERATURE'], unusualSound: null, vehicleMoves: true },
  },
  {
    fault: 'BRAKE_FAILURE',
    answers: { primaryComplaint: 'WARNING_LIGHT', engineCranks: 'UNSURE', warningLights: ['BRAKE'], unusualSound: 'GRINDING', vehicleMoves: true },
  },
  {
    fault: 'EV_HV_FAULT',
    answers: { primaryComplaint: 'WARNING_LIGHT', engineCranks: 'NO', warningLights: ['EV_SYSTEM'], unusualSound: 'NONE', vehicleMoves: true },
  },
  {
    fault: 'IMMOBILISED_UNKNOWN',
    answers: { primaryComplaint: 'STUCK_OR_DAMAGED', engineCranks: 'UNSURE', warningLights: ['OIL'], unusualSound: 'WHINING', vehicleMoves: false },
  },
];
