// CANDIDATE GENERATION — every (unit, technician) pair that could conceivably
// serve a job, with what each one would actually resolve and how long it
// would take to get there.
//
// THE ASSIGNMENT MATRIX MUST NEVER GROW PAST jobs x (unit, technician).
// Parts sourcing (Phase 19, in partSourcing.ts) and destination selection
// (Phase 22) are resolved INSIDE this function, collapsing to a single best
// choice per pair. If a future change would add a dimension to the matrix — a
// candidate per (unit, technician, part-sourcing-option), say, or per possible
// destination — that logic belongs HERE, folded down to one option per pair,
// not bolted on as a new loop that multiplies the option count. A solver that
// reasons over jobs x units x technicians x parts x destinations does not
// finish before the next job arrives. Parts made every option richer and the
// matrix exactly the same size, and there is a test that says so.
//
// This module has ZERO imports from prisma or redis — invariant 2, the solver
// never writes to the database, and this is the pure heart of it: a snapshot
// in, a plain array of options out. Everything it needs about the job and the
// fleet is passed in as plain data by whoever assembles the snapshot; nothing
// here reaches out to fetch anything for itself except real road travel time
// (src/infra/routing.ts), and that is deterministic and local — see
// routing.ts for why calling it does not compromise reproducibility the way a
// database or queue read would.

import { FAULT_CODES, capabilitiesForFault } from '../domain/faults.js';
import type { FaultCode, FaultDistribution } from '../domain/faults.js';
import { requiredCapabilities } from '../domain/capabilitySet.js';
import type { ContractTerms } from '../domain/contractExposure.js';
import { sourcePartsForPairs } from './partSourcing.js';
import type { PartsSnapshot, PartSourcing } from './partSourcing.js';
import { resolveDestinationForJob } from './destinationSelection.js';
import type { DestinationChoice, WorkshopsSnapshot } from './destinationSelection.js';
import { travelTimeMatrix } from '../infra/routing.js';
import type { LatLng, TravelTimeSource } from '../infra/routing.js';

// ---------------------------------------------------------------------------
// Input: the job needing dispatch, and a snapshot of the fleet to dispatch
// from. Plain data — none of it is a Prisma row, so a test can build one by
// hand with no database at all.

export type JobForDispatch = {
  id: string;
  lat: number;
  lng: number;
  // The output of Phase 3's entropy-driven intake, already computed and
  // stored on the job. Candidate generation does not diagnose anything — it
  // reads the belief intake already settled on.
  faultDistribution: FaultDistribution;
  // The five fields below are unused in this file — nothing in
  // generateCandidates reads them. They ride along on the same job object
  // because Phase 7's feasibility filter needs them and takes the exact same
  // JobForDispatch, and a job splitting into two overlapping "job for X" types
  // one field apart would be the onHighway mistake again: one fact, one home,
  // even when only one of the two readers needs it today.
  createdAt: Date;
  // null when the job has no SLA contract behind it (a walk-in customer) —
  // there is then no window to be unreachable within.
  slaResponseMinutes: number | null;
  // THE CONTRACT TERMS IN FORCE WHEN THIS JOB WAS RAISED, pinned at intake and
  // never recomputed — the same rule the price list and the settlement path
  // follow. Null for a job no contract stands behind, which is the honest
  // answer and not the same as a contract with a zero penalty.
  //
  // Read by the cost function (contractSlaExposure) and by the cross-tenant
  // contention check. NOT read by ranking: a tier can never outrank safety.
  contract: ContractTerms | null;
  parkingLevel: string | null;
  onHighway: boolean;
  // Read by ranking.ts, not by this file and not by the cost function —
  // invariant 4 puts it ABOVE cost in a lexicographic ordering rather than
  // inside it as a weighted term.
  safetyLevel: SafetyLevelSnapshot;
  // WHO THE VEHICLE IS, for destination selection (Phase 22) only — nothing
  // else in this file reads either field. `vehicleMake` is the same string
  // WorkshopAuthorisation.brand carries (MARUTI_SUZUKI, HYUNDAI, ...), and
  // `vehicleEvClass` mirrors Workshop.evClass: null for an ordinary vehicle,
  // 'LV' or 'HV' for one that needs EV-specific service. One fact, one home —
  // read once here rather than re-derived per pair, the same reasoning as
  // JobForDispatch's other passenger fields.
  vehicleMake: string;
  vehicleEvClass: string | null;
};

// Mirrors Prisma's SafetyLevel enum as a plain union, for the same reason
// UnitKindSnapshot below does.
export const SAFETY_LEVELS = ['NORMAL', 'ELEVATED', 'HIGH_RISK'] as const;
export type SafetyLevelSnapshot = (typeof SAFETY_LEVELS)[number];

// Plain string unions mirroring Prisma's UnitKind/UnitStatus enums, not
// imported from the generated Prisma client — this file's zero-imports rule
// is checked by a literal grep for the client package's name, and even a
// type-only import would still match it. Domain files (src/domain/location.ts)
// can import the real enum; engine files define their own copy of the
// vocabulary they need instead.
export const UNIT_KINDS = ['VAN', 'BIKE', 'FLATBED_TOW', 'WHEEL_LIFT_TOW'] as const;
export type UnitKindSnapshot = (typeof UNIT_KINDS)[number];

export const UNIT_STATUSES = ['AVAILABLE', 'HELD', 'ON_JOB', 'MAINTENANCE', 'OFFLINE'] as const;
export type UnitStatusSnapshot = (typeof UNIT_STATUSES)[number];

export type UnitSnapshot = {
  id: string;
  zoneId: string;
  // null when the unit has no crew right now. A unit in this state cannot
  // form a pair with anyone — see crewedPairs() below.
  currentTechnicianId: string | null;
  capabilityCodes: string[];
  // null when the unit has never reported a GPS position — see
  // unitLocation()'s zone-centroid fallback.
  lat: number | null;
  lng: number | null;
  // kind and status are unused in this file, same reason as JobForDispatch's
  // trailing five fields — Phase 7 reads them, this file does not.
  kind: UnitKindSnapshot;
  status: UnitStatusSnapshot;
};

export type TechnicianSnapshot = {
  id: string;
  capabilityCodes: string[];
};

// Carried in the snapshot because Phase 7's feasibility filter needs it (an
// off-shift technician is infeasible, not merely undesirable) — NOT because
// this file uses it. "Do not filter infeasible options here" means shift
// timing is read by the phase that filters, not the phase that enumerates.
export type ShiftSnapshot = {
  technicianId: string;
  startsAt: Date;
  endsAt: Date;
};

export type ZoneSnapshot = {
  id: string;
  centroidLat: number;
  centroidLng: number;
};

export type DispatchSnapshot = {
  units: UnitSnapshot[];
  technicians: TechnicianSnapshot[];
  shifts: ShiftSnapshot[];
  zones: ZoneSnapshot[];
  // What is on each van, what a part is worth, and where the depots are.
  //
  // ABSENT OR NULL MEANS "THIS SNAPSHOT DOES NOT MODEL PARTS", which is not
  // the same claim as "the vans are empty" and must not be read as one. The
  // production snapshot (src/commit/dispatchSnapshot.ts) always fills it in.
  // The evaluation harness's greedy baselines deliberately blank it, because
  // dispatching with no idea what is on the van is precisely the behaviour
  // they exist to measure against.
  parts?: PartsSnapshot | null;
  // The workshop network (Phase 22) — same absent-means-not-modelled rule as
  // `parts` above, for the same reason: a tow job in a snapshot with no
  // workshops data is NOT_MODELLED, never silently "no workshop exists".
  workshops?: WorkshopsSnapshot | null;
};

// ---------------------------------------------------------------------------
// Output.

export type DispatchOption = {
  unitId: string;
  technicianId: string;
  estimatedTravelMinutes: number;
  // True when `estimatedTravelMinutes` came from the haversine fallback in
  // routing.ts, not a real OSRM road route. Not one of the four fields the
  // build plan names for DispatchOption, but the same plan's routing section
  // requires a degraded estimate to be "visible to the operator" (invariant
  // 8), and this is the only place in this phase's output for that fact to
  // live — Phase 9 gives dispatch options a database row, and this field is
  // what will land in it.
  travelEstimateDegraded: boolean;
  // Road distance for the same trip. Carried alongside the minutes because
  // they are not interchangeable inputs: a cost function's time term wants
  // minutes, and its fuel/wear term wants kilometres. Deriving one from the
  // other would mean assuming an average speed the road graph already knows
  // better than we do.
  estimatedTravelKm: number;
  // Exactly which faults this pair would arrive able to resolve outright:
  // SKILL and PART together, which is what Phase 19 made `canResolve` mean.
  // The scalar below is this list weighted by probability — but a duration
  // model needs to know WHICH faults, not just how much probability mass,
  // because diagnose and resolve times differ per fault. Kept as a list rather
  // than recomputed downstream so the intersection is applied in one place.
  resolvableFaults: FaultCode[];
  // The same list BEFORE parts were considered — what the crew is trained and
  // equipped to do. The difference between the two lists is the whole subject
  // of the parts layer, and it is what lets the driver's screen say "has the
  // skills but needs a part" instead of the much bleaker "cannot help you".
  skillResolvableFaults: FaultCode[];
  // Where the parts come from, already collapsed to one answer — see
  // partSourcing.ts for why that collapse is the point.
  partSourcing: PartSourcing;
  // What fraction of the job's ENTIRE fault-probability mass this pair could
  // resolve outright, across all twelve fault codes — not just the ones
  // intake narrowed the diagnosis to. A generalist technician who can fix
  // nearly anything scores near 1.0 even against an uncertain diagnosis; a
  // narrow specialist scores low even standing right next to the vehicle.
  coveredFaultProbability: number;
  // Capability codes the job's CONTENDING faults need (the same coverage-mass
  // calculation intake already uses to decide when to stop asking questions)
  // that this pair's intersected skills do not have. Empty means this pair
  // can fully handle every fault still seriously in contention.
  missingCapabilities: string[];
  // Where a tow goes, already collapsed to one answer — see
  // destinationSelection.ts for why this is resolved once PER JOB rather than
  // per pair, unlike partSourcing above it. Every option for the same job
  // carries the identical value.
  destination: DestinationChoice;
};

// ---------------------------------------------------------------------------
// The pairs. A "pair" needs both halves to exist — a unit with no crew right
// now has no technician to pair it with, so it produces no option at all, not
// a rejected one. Rejection (Phase 7) is for pairs that exist but should not
// be sent; an uncrewed unit is not a pair in the first place.

type CrewedPair = { unit: UnitSnapshot; technician: TechnicianSnapshot };

function crewedPairs(snapshot: DispatchSnapshot): CrewedPair[] {
  const techniciansById = new Map(snapshot.technicians.map((technician) => [technician.id, technician]));
  const pairs: CrewedPair[] = [];

  for (const unit of snapshot.units) {
    if (!unit.currentTechnicianId) continue;

    const technician = techniciansById.get(unit.currentTechnicianId);
    // The unit says it has a crew whose id is not in the snapshot. That is a
    // snapshot-assembly bug, not a business rule this function should reason
    // about — skip quietly rather than inventing a fake technician.
    if (!technician) continue;

    pairs.push({ unit, technician });
  }

  return pairs;
}

// technician skills INTERSECTED with unit capabilities — a technician
// certified for EV work sitting in a bike with no EV tools still cannot do EV
// work, and a fully EV-equipped van with a non-certified technician cannot
// either. The pair can only do what BOTH sides agree on.
function intersectedCapabilities(pair: CrewedPair): Set<string> {
  const unitCodes = new Set(pair.unit.capabilityCodes);
  return new Set(pair.technician.capabilityCodes.filter((code) => unitCodes.has(code)));
}

function resolvableFaults(capabilities: Set<string>): FaultCode[] {
  return FAULT_CODES.filter((fault) => canResolve(fault, capabilities));
}

function coveredFaultProbability(distribution: FaultDistribution, resolvable: FaultCode[]): number {
  let covered = 0;
  for (const fault of resolvable) covered += distribution[fault];
  return covered;
}

function canResolve(fault: FaultCode, capabilities: Set<string>): boolean {
  return capabilitiesForFault(fault).every((code) => capabilities.has(code));
}

// ---------------------------------------------------------------------------
// Where a unit actually is, for routing. Falls back to the unit's zone
// centroid when it has never reported a GPS position — an administrative
// approximation, the same spirit as intake using a zone centroid before a
// precise location exists (src/domain/geo.ts).
// Exported: feasibility.ts's opposite-carriageway check needs the same
// resolved location this file uses for routing, and a unit's location has one
// home, not a copy recomputed per file.
export function unitLocation(unit: UnitSnapshot, zonesById: Map<string, ZoneSnapshot>): LatLng {
  if (unit.lat !== null && unit.lng !== null) {
    return { lat: unit.lat, lng: unit.lng };
  }

  const zone = zonesById.get(unit.zoneId);
  if (zone) return { lat: zone.centroidLat, lng: zone.centroidLng };

  // Every unit's zoneId is a real foreign key and every zone in the snapshot
  // should be one the fleet actually uses — reaching here means the snapshot
  // was assembled wrong. Throwing beats guessing 0,0, which would silently
  // claim the unit is off the coast of Africa.
  throw new Error(`unit ${unit.id} has no location and no known zone ${unit.zoneId}`);
}

// ---------------------------------------------------------------------------
// The whole function. Async only because real travel time means one HTTP
// round trip to the local OSRM container (routing.ts) — everything else here
// is synchronous arithmetic over the snapshot already in hand.
//
// `travelTimes` defaults to the production OSRM matrix and is a parameter for
// one reason: the Phase 10 evaluation harness replays a scenario many times
// and needs travel time to come from somewhere local, instant and identical
// on every run (invariant 10). It passes `haversineTravelTimes`. Nothing else
// overrides it, and the default means no other call site had to change.
//
// `now` DEFAULTS TO THE WALL CLOCK, the same non-purity trade-off
// `travelTimes` already makes for production, and for the same reason: a
// workshop's open/closed state and its P(accept) bucket are both functions of
// the actual hour, and callers that need determinism already pass their own
// (src/engine/solve.ts threads through the `now` it was given; the Phase 10
// harness passes a fixed instant). Existing callers that pass neither
// `travelTimes` nor `now` are jobs that never need a tow, so the default
// changes nothing for them.
export async function generateCandidates(
  job: JobForDispatch,
  snapshot: DispatchSnapshot,
  travelTimes: TravelTimeSource = travelTimeMatrix,
  now: Date = new Date(),
): Promise<DispatchOption[]> {
  const pairs = crewedPairs(snapshot);
  if (pairs.length === 0) return [];

  const zonesById = new Map(snapshot.zones.map((zone) => [zone.id, zone]));
  const origins = pairs.map((pair) => unitLocation(pair.unit, zonesById));
  const destination: LatLng = { lat: job.lat, lng: job.lng };

  // ONE round trip for every pair's travel time, not one per pair — see
  // travelTimeMatrix's own comment for why that is the point of using OSRM's
  // /table endpoint instead of calling /route in a loop.
  const travel = await travelTimes(origins, destination);

  const required = requiredCapabilities(job.faultDistribution);

  const skills = pairs.map((pair) => intersectedCapabilities(pair));
  const skilled = skills.map((capabilities) => resolvableFaults(capabilities));

  // PARTS ARE RESOLVED HERE, one answer per pair, and the result narrows what
  // each pair can actually finish rather than adding options to choose from.
  const sourced = await sourcePartsForPairs({
    job,
    parts: snapshot.parts ?? null,
    pairs: pairs.map((pair, index) => ({
      unitId: pair.unit.id,
      skilledFaults: skilled[index]!,
      from: origins[index]!,
      travelMinutesToJob: travel[index]!.minutes,
    })),
    destination,
    travelTimes,
  });

  // ONE DESTINATION FOR THE WHOLE JOB — see destinationSelection.ts's own
  // header for why this call sits outside the per-pair map below rather than
  // inside it, unlike parts.
  const destinationChoice = await resolveDestinationForJob({
    job,
    vehicleMake: job.vehicleMake,
    vehicleEvClass: job.vehicleEvClass,
    workshops: snapshot.workshops,
    now,
    travelTimes,
  });

  return pairs.map((pair, index) => {
    const capabilities = skills[index]!;
    const estimate = travel[index]!;
    const resolvable = sourced[index]!.sourcedFaults;

    return {
      unitId: pair.unit.id,
      technicianId: pair.technician.id,
      estimatedTravelMinutes: estimate.minutes,
      travelEstimateDegraded: estimate.degraded,
      estimatedTravelKm: estimate.kilometres,
      resolvableFaults: resolvable,
      skillResolvableFaults: skilled[index]!,
      partSourcing: sourced[index]!.sourcing,
      coveredFaultProbability: coveredFaultProbability(job.faultDistribution, resolvable),
      missingCapabilities: required.filter((code) => !capabilities.has(code)),
      destination: destinationChoice,
    };
  });
}
