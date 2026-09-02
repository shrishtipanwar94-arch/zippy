// FEASIBILITY — hard filters with reason codes.
//
// THE CODES ARE WORTH MORE THAN THE FILTER. `rejected` is not debug logging;
// it is a first-class output. It renders in the "Why this technician?" panel
// at Phase 14 — an operator (or a driver, wondering why the closest van did
// not come) has to be able to see, in plain language, that the nearest unit
// was skipped because it is an unequipped bike, not because the algorithm is
// a black box. It is persisted on the SolverRun from Phase 9 onward.
//
// INVARIANT 3 — THESE ARE FILTERS, NEVER PENALTIES. It would be shorter to
// fold "no EV certification" into the cost function as a very large number
// and let the ranking sort it to the bottom. Do not do this. A penalty big
// enough to act as a constraint is a constraint wearing a disguise, and the
// disguise is exactly where the bug hides: given enough other terms — a
// desperate SLA, an empty zone, a bad enough day — some combination of costs
// eventually outweighs even a large penalty, and the system dispatches an
// uncertified technician to a live high-voltage fault. A filter cannot be
// outvoted by anything. It removes the option before the cost function ever
// sees it.
//
// Runs after src/engine/candidates.ts and before src/engine/cost.ts
// (Phase 8) — feasibility narrows what the cost function is even allowed to
// rank. Zero imports from prisma or redis, the same rule and the same reason
// as candidates.ts: this is a pure decision over a snapshot, not a database
// query with opinions.

import { distanceKm } from '../domain/geo.js';
import { requiredCapabilities } from '../domain/capabilitySet.js';
import { MAX_PART_SOURCING_DETOUR_MINUTES } from './partSourcing.js';
import { unitLocation } from './candidates.js';
import type {
  DispatchOption,
  DispatchSnapshot,
  JobForDispatch,
  TechnicianSnapshot,
  UnitKindSnapshot,
  UnitSnapshot,
  ZoneSnapshot,
} from './candidates.js';

// ---------------------------------------------------------------------------
// The codes the build plan names — ten at Phase 7, eleven from Phase 22 — in
// the order this file checks them. Order matters: an option can fail more
// than one, and each option carries exactly one code — the first, most
// fundamental reason it cannot be sent. A unit that is offline AND lacks a
// capability is rejected for being
// offline; whether it also lacks the capability is moot until it exists.

// ELEVEN, NOT TEN, as of Phase 22. Brand authorisation and EV class are
// SEPARATE codes — "authorised for Maruti but not for EVs" is a distinct and
// real failure, and collapsing the two into one DESTINATION_NOT_AUTHORISED
// would make the why-inspector unable to say which. The build plan named ten
// when this file was written at Phase 7; DESTINATION_EV_CLASS_MISMATCH is the
// one it did not yet have a name for.
export type RejectionCode =
  | 'UNIT_UNAVAILABLE'
  | 'VEHICLE_TYPE_INCOMPATIBLE'
  | 'CAPABILITY_MISSING'
  | 'ACCESS_RESTRICTION'
  | 'NO_TECHNICIAN_ON_SHIFT'
  | 'SLA_UNREACHABLE'
  | 'PART_UNAVAILABLE'
  | 'NO_DESTINATION_AVAILABLE'
  | 'DESTINATION_NOT_AUTHORISED'
  | 'DESTINATION_EV_CLASS_MISMATCH'
  | 'TENANT_CONTRACT_EXCLUDES';

export type Rejection = {
  option: DispatchOption;
  code: RejectionCode;
  detail: string;
};

export type FeasibilityResult = {
  feasible: DispatchOption[];
  rejected: Rejection[];
};

// ---------------------------------------------------------------------------
// Constants a real duration model or contract lookup will eventually replace.
// Named and commented so nobody mistakes them for measured values.

// No fault-specific repair-time model exists yet (a future phase's job).
// Used only to ask "could this technician plausibly finish before their
// shift ends" — a rough, deliberately conservative placeholder, not an ETA
// promised to a driver.
const ASSUMED_SERVICE_DURATION_MINUTES = 45;

// Real OSRM detours in ordinary traffic run well under 2x the straight-line
// distance's travel time; Phase 6 measured a genuine divided-highway crossing
// at roughly 24x-243x. 4x sits comfortably between "normal road inefficiency"
// and "the unit is on the wrong carriageway," with no per-unit heading data
// required to draw that line.
const HIGHWAY_DETOUR_RATIO_THRESHOLD = 4;
const DIRECT_SPEED_KMH_FOR_DETOUR_CHECK = 40;

// Only these two unit kinds are ever equipped to load or winch a vehicle
// (prisma/seed/fleet.ts) — a fact about the physical vehicle class, checked
// here independently of whatever capability codes happen to be attached to a
// specific unit row, so a data-entry mistake in the capability table cannot
// accidentally clear a bike to tow.
const TOW_CAPABLE_KINDS: ReadonlySet<UnitKindSnapshot> = new Set(['FLATBED_TOW', 'WHEEL_LIFT_TOW']);
const TOW_CAPABILITY_CODES: ReadonlySet<string> = new Set(['FLATBED_LOADING', 'WINCH_RECOVERY']);

// The same two kinds a basement ramp cannot clear — a flatbed or a wheel-lift
// truck's length and ground clearance, not a capability a technician can
// train their way around.
const BASEMENT_INACCESSIBLE_KINDS: ReadonlySet<UnitKindSnapshot> = new Set(['FLATBED_TOW', 'WHEEL_LIFT_TOW']);

// ---------------------------------------------------------------------------

function jobNeedsTow(job: JobForDispatch): boolean {
  return requiredCapabilities(job.faultDistribution).some((code) => TOW_CAPABILITY_CODES.has(code));
}

function isBasementLevel(parkingLevel: string | null): boolean {
  // The simulator's own format (src/sim/scenarios.ts): "B1", "B2", "B3".
  return parkingLevel !== null && /^b/i.test(parkingLevel);
}

// A fixed-speed "what would a direct trip of this straight-line distance
// normally take" baseline — not a claim about the real road, only a ruler to
// measure the REAL travel time against. See HIGHWAY_DETOUR_RATIO_THRESHOLD.
function likelyOnWrongCarriageway(
  option: DispatchOption,
  unit: UnitSnapshot,
  job: JobForDispatch,
  zonesById: Map<string, ZoneSnapshot>,
): boolean {
  if (!job.onHighway) return false;

  const from = unitLocation(unit, zonesById);
  const straightKm = distanceKm(from.lat, from.lng, job.lat, job.lng);
  if (straightKm < 0.01) return false; // already essentially at the job; no detour to detect

  const directMinutes = (straightKm / DIRECT_SPEED_KMH_FOR_DETOUR_CHECK) * 60;
  return option.estimatedTravelMinutes > directMinutes * HIGHWAY_DETOUR_RATIO_THRESHOLD;
}

// WHEN THE CREW WOULD ACTUALLY REACH THE VEHICLE. Driving straight there is
// only the whole answer when they already have the part; a crew diverting
// through a depot to collect one arrives later, and both the SLA promise and
// the end of a shift care about the real number rather than the road time.
function arrivalMinutes(option: DispatchOption): number {
  return option.estimatedTravelMinutes + option.partSourcing.detourMinutes;
}

function hasShiftTimeToComplete(
  technicianId: string,
  option: DispatchOption,
  shifts: DispatchSnapshot['shifts'],
  now: Date,
): boolean {
  const requiredMinutes = arrivalMinutes(option) + ASSUMED_SERVICE_DURATION_MINUTES;
  const completesAt = new Date(now.getTime() + requiredMinutes * 60_000);

  return shifts.some(
    (shift) => shift.technicianId === technicianId && shift.startsAt <= now && completesAt <= shift.endsAt,
  );
}

function slaDeadline(job: JobForDispatch): Date | null {
  if (job.slaResponseMinutes === null) return null;
  return new Date(job.createdAt.getTime() + job.slaResponseMinutes * 60_000);
}

// ---------------------------------------------------------------------------
// PART_UNAVAILABLE and the destination checks below were STUBS through
// earlier phases and are real now — each was wired here with real plumbing
// from the start, called in the fixed order above and returning a rejection
// or null, so the phase that gave it teeth only had to fill in the condition.
// TENANT_CONTRACT_EXCLUDES, further down, is the one still waiting.

// PART_UNAVAILABLE — the crew has the skill and cannot get the part.
//
// Real from Phase 19. The sourcing decision itself was made in candidate
// generation (src/engine/partSourcing.ts), which already tried the van and a
// depot run and counted UNVERIFIED stock as absent; this filter only reads the
// verdict. That split is what stops the same arithmetic existing twice.
//
// IT RUNS AFTER CAPABILITY_MISSING ON PURPOSE. By the time an option reaches
// here it holds every skill the contending faults need, so this code means one
// thing and one thing only — "Ravi can do this, and there is no belt" — which
// is what makes the escalation card a sentence a dispatcher can act on rather
// than a shrug.
function checkPartAvailability(option: DispatchOption, _job: JobForDispatch): Rejection['detail'] | null {
  if (option.partSourcing.status !== 'UNAVAILABLE') return null;

  return (
    `no source for ${option.partSourcing.missingSkus.join(', ')}: not believably on the van, ` +
    `and no depot run within ${MAX_PART_SOURCING_DETOUR_MINUTES} minutes`
  );
}

// DESTINATION — real from Phase 22. The screening decision itself was made in
// candidate generation (src/engine/destinationSelection.ts), which already
// filtered by brand, EV class, opening hours and reachability and collapsed
// the result to one status; this reads the verdict, the same split
// checkPartAvailability makes for parts. ONE function rather than two,
// because destinationSelection.ts already tells the three kinds of failure
// apart — there is no ambiguity left here for two separate checks to order
// between.
function checkDestination(option: DispatchOption, _job: JobForDispatch): Omit<Rejection, 'option'> | null {
  const destination = option.destination;

  if (destination.status === 'NO_BRAND_MATCH') {
    return { code: 'DESTINATION_NOT_AUTHORISED', detail: destination.detail };
  }
  if (destination.status === 'NO_EV_CLASS_MATCH') {
    return { code: 'DESTINATION_EV_CLASS_MISMATCH', detail: destination.detail };
  }
  if (destination.status === 'NO_DESTINATION_REACHABLE') {
    return { code: 'NO_DESTINATION_AVAILABLE', detail: destination.detail };
  }

  // NOT_NEEDED (not a tow), NOT_MODELLED (this snapshot does not model
  // workshops) and CHOSEN all pass — the same "we did not look" rule
  // PART_UNAVAILABLE follows for NOT_MODELLED.
  return null;
}

// TENANT_CONTRACT_EXCLUDES — AND WHY PHASE 20 DELIBERATELY LEFT IT A STUB.
//
// The tenancy layer is live: a job carries the contract terms it was pinned to
// at creation, and the cost function prices a breach against them
// (src/domain/contractExposure.ts). What did NOT arrive with it is a case where
// a contract makes an option illegal, and the reason is worth reading, because
// the obvious candidate looks like one and is not.
//
// `covered_services.covered = false` means "this contract does not pay for this
// service". It does not mean "do not send anyone". A driver whose contract
// excludes towing is a WALK-IN for that job — src/domain/settlementPath.ts
// resolves exactly that, and they are served and billed accordingly. Turning
// cover into a hard filter would make the system refuse to help a stranded
// person over a billing question, which is the same mistake the SLA filter
// already had to be talked out of (see the comment on the deadline check above).
//
// So this code is reserved rather than implemented, and it is reserved for a
// genuine exclusion: a contract that names which providers may serve it. No
// such term exists in the schema, so nothing here can be honest yet. Never
// rejects — see INTERVIEW.md §15.
function checkTenantContract(_option: DispatchOption, _job: JobForDispatch): Rejection['detail'] | null {
  return null;
}

// ---------------------------------------------------------------------------
// One option, classified. Returns the single reason it cannot be sent, or
// null when it survives every check.
function classify(
  option: DispatchOption,
  unit: UnitSnapshot,
  technician: TechnicianSnapshot,
  job: JobForDispatch,
  snapshot: DispatchSnapshot,
  now: Date,
  zonesById: Map<string, ZoneSnapshot>,
): Omit<Rejection, 'option'> | null {
  if (unit.status !== 'AVAILABLE') {
    return { code: 'UNIT_UNAVAILABLE', detail: `unit is ${unit.status.toLowerCase()}` };
  }

  if (jobNeedsTow(job) && !TOW_CAPABLE_KINDS.has(unit.kind)) {
    return {
      code: 'VEHICLE_TYPE_INCOMPATIBLE',
      detail: `${unit.kind} cannot tow or winch a vehicle`,
    };
  }

  if (option.missingCapabilities.length > 0) {
    return {
      code: 'CAPABILITY_MISSING',
      detail: `missing: ${option.missingCapabilities.join(', ')}`,
    };
  }

  if (isBasementLevel(job.parkingLevel) && BASEMENT_INACCESSIBLE_KINDS.has(unit.kind)) {
    return {
      code: 'ACCESS_RESTRICTION',
      detail: `${unit.kind} cannot access parking level ${job.parkingLevel}`,
    };
  }
  if (likelyOnWrongCarriageway(option, unit, job, zonesById)) {
    return {
      code: 'ACCESS_RESTRICTION',
      detail: `road time (${option.estimatedTravelMinutes.toFixed(1)}min) implies the far side of a divider`,
    };
  }

  if (!hasShiftTimeToComplete(technician.id, option, snapshot.shifts, now)) {
    return {
      code: 'NO_TECHNICIAN_ON_SHIFT',
      detail: 'technician is off shift, or their shift ends before the job could complete',
    };
  }

  // SLA — A FILTER ONLY WHILE THE PROMISE CAN STILL BE KEPT.
  //
  // This check used to run against every option regardless of when `now` was,
  // and Phase 10's harness measured what that did: because the deadline is a
  // function of the clock, a job still queued when its window closed had
  // EVERY option rejected, forever. It stopped appearing in any plan and
  // nothing said so — a stranded customer, invisible, whose only trace was a
  // rejection code that reads exactly like the healthy case of one van being
  // too far away. Across a busy scenario that accounted for most of the
  // unserved jobs.
  //
  // Refusing to dispatch to a job you are already late for is not a way to
  // avoid breaching an SLA; it is a way to turn a late arrival into no
  // arrival. So the filter now applies only while the window is still open:
  // prefer a crew who can genuinely make it, and once the promise is already
  // broken let the job compete normally on cost. The breach itself is a
  // commercial fact, handled by a RECOMMEND action
  // (src/commit/slaEscalation.ts), not by withholding a van.
  const deadline = slaDeadline(job);
  if (deadline && deadline > now) {
    const arrivesAt = new Date(now.getTime() + arrivalMinutes(option) * 60_000);
    if (arrivesAt > deadline) {
      return {
        code: 'SLA_UNREACHABLE',
        detail: `arrival ${arrivesAt.toISOString()} is after the ${job.slaResponseMinutes}min SLA deadline ${deadline.toISOString()}`,
      };
    }
  }

  const partDetail = checkPartAvailability(option, job);
  if (partDetail) return { code: 'PART_UNAVAILABLE', detail: partDetail };

  const destinationRejection = checkDestination(option, job);
  if (destinationRejection) return destinationRejection;

  const contractDetail = checkTenantContract(option, job);
  if (contractDetail) return { code: 'TENANT_CONTRACT_EXCLUDES', detail: contractDetail };

  return null;
}

// ---------------------------------------------------------------------------
export function checkFeasibility(
  options: DispatchOption[],
  job: JobForDispatch,
  snapshot: DispatchSnapshot,
  now: Date,
): FeasibilityResult {
  const unitsById = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  const techniciansById = new Map(snapshot.technicians.map((technician) => [technician.id, technician]));
  const zonesById = new Map(snapshot.zones.map((zone) => [zone.id, zone]));

  const feasible: DispatchOption[] = [];
  const rejected: Rejection[] = [];

  for (const option of options) {
    const unit = unitsById.get(option.unitId);
    const technician = techniciansById.get(option.technicianId);
    // candidates.ts only ever emits an option for a pair drawn from the same
    // snapshot passed here — a caller handing feasibility a DIFFERENT
    // snapshot than the one that generated these options is a wiring bug,
    // not a business condition this function has an opinion about.
    if (!unit || !technician) {
      throw new Error(
        `option (${option.unitId}, ${option.technicianId}) not found in the snapshot passed to checkFeasibility`,
      );
    }

    const rejection = classify(option, unit, technician, job, snapshot, now, zonesById);
    if (rejection) {
      rejected.push({ option, ...rejection });
    } else {
      feasible.push(option);
    }
  }

  return { feasible, rejected };
}
