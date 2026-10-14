// THE REASON CODES, IN WORDS — twice, because the console asks two different
// questions of them.
//
// A feasibility code is a fact about ONE (crew, job) pairing. The plan card
// asks a question about a JOB — "why is this one still waiting?" — and the
// solve trace and the inspector ask a question about the CREWS — "how many
// were ruled out, and for what?". The same code answers both, and the two
// answers are not the same sentence: "no crew holds the skills the fault
// needs" is true of a job, and reads as nonsense next to a count of vans.
//
// So there are two maps, and they live in one file so that a code added to one
// and forgotten in the other is a diff nobody can miss. Both are asserted
// against src/engine/feasibility.ts's RejectionCode union by
// tests/unassignedReasons.test.ts — the console has no build step and cannot
// import the engine's types, so a test does what a compiler would.

// WHY ONE JOB IS STILL WAITING. Used by the plan card, where the subject of the
// count is a job: "6 no crew holds the skills the fault needs".
export const REJECTION_PHRASES = {
  UNIT_UNAVAILABLE: 'every capable unit is already on a job',
  VEHICLE_TYPE_INCOMPATIBLE: 'no unit can handle the vehicle',
  CAPABILITY_MISSING: 'no crew holds the skills the fault needs',
  ACCESS_RESTRICTION: 'no unit can physically reach the vehicle',
  NO_TECHNICIAN_ON_SHIFT: 'capable units have no technician on shift',
  SLA_UNREACHABLE: 'unreachable within SLA',
  PART_UNAVAILABLE: 'the part is not in any van in range',
  NO_DESTINATION_AVAILABLE: 'no workshop can take it',
  DESTINATION_NOT_AUTHORISED: 'no authorised destination',
  DESTINATION_EV_CLASS_MISMATCH: 'no destination certified for the EV class',
  TENANT_CONTRACT_EXCLUDES: 'the contract excludes this work',
};

// WHY ONE CREW WAS RULED OUT. Used by the solve trace and the inspector, where
// the subject of the count is a crew: "184 no crew with the right skill".
// Deliberately noun phrases rather than verbs, so a count of one and a count of
// a hundred both read correctly without the console conjugating anything.
export const CREW_REJECTION_PHRASES = {
  UNIT_UNAVAILABLE: 'already out on another job',
  VEHICLE_TYPE_INCOMPATIBLE: 'the wrong kind of vehicle for this job',
  CAPABILITY_MISSING: 'no crew with the right skill',
  ACCESS_RESTRICTION: 'no way to physically reach the vehicle',
  NO_TECHNICIAN_ON_SHIFT: 'nobody on shift within reach',
  SLA_UNREACHABLE: 'too far to arrive inside the promised window',
  PART_UNAVAILABLE: 'the part is not on board and cannot be collected in time',
  NO_DESTINATION_AVAILABLE: 'nowhere open to tow it to',
  DESTINATION_NOT_AUTHORISED: 'no workshop authorised for this brand',
  DESTINATION_EV_CLASS_MISMATCH: 'no workshop equipped for this EV class',
  TENANT_CONTRACT_EXCLUDES: 'excluded by the contract',
};

// "12 no crew with the right skill · 6 nobody on shift within reach", ordered
// by how many. The shape the plan card has used since Phase 14, so a count on
// the trace and a count on a card read the same way.
export function describeCrewRejections(countsByCode) {
  return Object.entries(countsByCode ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} ${CREW_REJECTION_PHRASES[code] ?? code}`);
}

// A JOB THAT LOST A UNIT TO A HIGHER-PRIORITY JOB was not refused by anything,
// so it has no feasibility code and must not be given one. It is counted under
// this key instead — by the engine (src/engine/trace.ts CONTENTION_REASON) and
// by the plan card — and worded here.
export const CONTENTION_PHRASE = 'lost a unit to a higher-priority job';

// "6 no crew holds the skills the fault needs · 4 unreachable within SLA",
// ordered by how many. One formatter for both places that say this — the plan
// card, which tallies the counts itself, and the solve trace, which is handed
// them by the engine — so the two can word the same fact differently only by
// somebody editing this function.
export function describeJobRejections(countsByCode) {
  return Object.entries(countsByCode ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => {
      const phrase = code === 'CONTENTION' ? CONTENTION_PHRASE : REJECTION_PHRASES[code];
      return `${count} ${phrase ?? code}`;
    });
}
