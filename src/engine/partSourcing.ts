// WHERE THE PART COMES FROM — resolved for each (unit, technician) pair and
// collapsed to ONE answer per pair, before the assignment problem is built.
//
// THE POINT OF THIS FILE IS THE COLLAPSE. A crew that needs a battery could
// get one three ways: it is already on the van, they divert through a depot to
// pick one up, or nobody can get one to them today. Modelled naively that is a
// third dimension on the assignment matrix — jobs x units x technicians x
// part-source — and a solver reasoning over that does not finish before the
// next call arrives. So the choice between sources is made HERE, per pair,
// against a fixed job, and only the winner is carried forward. Parts make each
// option RICHER, never the matrix BIGGER; tests/candidates.test.ts asserts the
// option count still equals the pair count.
//
// FAIL CLOSED. Stock whose count is UNVERIFIED — nobody has looked in the back
// of that van for eight hours, see src/domain/stockConfidence.ts — is treated
// as ABSENT. Assuming a part is there when it may not be sends a crew who
// arrives, opens the shelf, finds nothing, and leaves the driver waiting for a
// second dispatch. Assuming it is missing when it is really there costs a
// detour we did not need. The first mistake is much worse than the second, so
// the arithmetic is deliberately pessimistic.
//
// A DEPOT HAS NO INVENTORY OF ITS OWN. Phase 18 was explicit that a depot is
// an address a restock happens at and nothing more, so "the depot can supply
// it" is always true here. That is a real simplification, recorded as a
// weakness rather than hidden: giving depots stock levels would be a second
// copy of the whole inventory problem sitting inside a routing problem.
//
// Zero imports from prisma or redis, the same rule as the rest of /src/engine.

import { contendingFaults } from '../domain/capabilitySet.js';
import { partSkusForFault } from '../domain/faults.js';
import type { FaultCode } from '../domain/faults.js';
import type { StockConfidence } from '../domain/stockConfidence.js';
import type { LatLng, TravelTimeSource } from '../infra/routing.js';
import type { JobForDispatch } from './candidates.js';

// ---------------------------------------------------------------------------
// The parts half of a dispatch snapshot. Plain data, read out of Postgres by
// src/commit/dispatchSnapshot.ts, exactly like the fleet half.

export type PartStockSnapshot = {
  unitId: string;
  sku: string;
  quantity: number;
  // Computed AS AT the snapshot instant rather than stored. A shelf that was
  // VERIFIED at nine is AGEING at eleven with nothing written in between, so
  // the moment the picture was taken is part of the picture.
  confidence: StockConfidence;
};

export type DepotSnapshot = { id: string; code: string; lat: number; lng: number };

export type PartsSnapshot = {
  stock: PartStockSnapshot[];
  // SKU -> what one costs, from the price list in force. Used to PRICE a depot
  // run, never to bill anybody — the estimate builder does that.
  valuePaiseBySku: Record<string, number>;
  depots: DepotSnapshot[];
};

// ---------------------------------------------------------------------------
// The single sourcing decision carried on every DispatchOption.

export const PART_SOURCING_STATUSES = [
  // This snapshot does not model parts at all: the pre-Phase-19 callers, and
  // the deliberately stock-blind evaluation baselines. NOT the same as "we
  // looked and found nothing" — it never rejects anything.
  'NOT_MODELLED',
  'IN_VAN',
  'WORKSHOP_RUN',
  'UNAVAILABLE',
] as const;

export type PartSourcingStatus = (typeof PART_SOURCING_STATUSES)[number];

export type PartSourcing = {
  status: PartSourcingStatus;
  // Extra minutes on the road to collect the parts, over and above driving
  // straight to the job. Zero unless the status is WORKSHOP_RUN.
  detourMinutes: number;
  partValuePaise: number;
  depotId: string | null;
  // SKUs the contending faults need that this van does not believably have.
  missingSkus: string[];
};

// A depot run that adds more than this to the trip is not a rescue, it is a
// second dispatch wearing a costume — and a second dispatch is already priced
// by the escalation term in cost.ts, run by a crew who does not have to drive
// the wrong way first. Past this line the option is rejected outright
// (PART_UNAVAILABLE) rather than carried at an enormous cost, because
// invariant 3 says a constraint is a filter and never a big number.
export const MAX_PART_SOURCING_DETOUR_MINUTES = 45;

// The sourcing answer for a snapshot that has no parts model. Exported
// because every hand-built DispatchOption — in a test, or anywhere a caller
// constructs an option without going through generateCandidates — needs the
// same "we did not look" value rather than inventing its own.
export const NO_PARTS_MODELLED: PartSourcing = {
  status: 'NOT_MODELLED',
  detourMinutes: 0,
  partValuePaise: 0,
  depotId: null,
  missingSkus: [],
};

const IN_VAN: PartSourcing = {
  status: 'IN_VAN',
  detourMinutes: 0,
  partValuePaise: 0,
  depotId: null,
  missingSkus: [],
};

// ---------------------------------------------------------------------------
// What is believably on one van right now.

export function believableSkus(stock: PartStockSnapshot[], unitId: string): Set<string> {
  const skus = new Set<string>();

  for (const line of stock) {
    if (line.unitId !== unitId) continue;
    if (line.quantity <= 0) continue;
    // The fail-closed rule, in one line.
    if (line.confidence === 'UNVERIFIED') continue;
    skus.add(line.sku);
  }

  return skus;
}

// A fault the crew has the SKILL for is only actually resolvable if the parts
// it consumes will be in their hands when they arrive. Four faults consume
// nothing at all — a jump start, a lockout, a tow — and are always sourced.
export function faultIsSourced(
  fault: FaultCode,
  available: Set<string>,
  sourcing: PartSourcing,
): boolean {
  if (sourcing.status === 'NOT_MODELLED') return true;

  const skus = partSkusForFault(fault);
  if (sourcing.status !== 'WORKSHOP_RUN') return skus.every((sku) => available.has(sku));

  // The run collects exactly the SKUs it was sent for. A fault outside the
  // contending set whose part is absent stays unresolvable — the crew is not
  // picking up things nobody asked them to.
  return skus.every((sku) => available.has(sku) || sourcing.missingSkus.includes(sku));
}

// SKUs needed by the faults this crew could skill-resolve and that the job is
// still seriously entertaining. NOT every fault in the distribution: a 2% tail
// possibility should not send a van on a detour, for the same reason it does
// not add a capability to the requirement (src/domain/capabilitySet.ts).
function missingSkusFor(
  job: JobForDispatch,
  skilledFaults: FaultCode[],
  available: Set<string>,
): string[] {
  const contenders = new Set(contendingFaults(job.faultDistribution));
  const missing = new Set<string>();

  for (const fault of skilledFaults) {
    if (!contenders.has(fault)) continue;
    for (const sku of partSkusForFault(fault)) {
      if (!available.has(sku)) missing.add(sku);
    }
  }

  return [...missing].sort();
}

// ---------------------------------------------------------------------------
// One pair's sourcing decision, given the depot run already measured for it.

function decide(
  missingSkus: string[],
  valuePaiseBySku: Record<string, number>,
  depotRun: { depotId: string; detourMinutes: number } | null,
): PartSourcing {
  if (missingSkus.length === 0) return IN_VAN;

  const noSource: PartSourcing = {
    status: 'UNAVAILABLE',
    detourMinutes: 0,
    partValuePaise: 0,
    depotId: null,
    missingSkus,
  };

  if (!depotRun) return noSource;
  if (depotRun.detourMinutes > MAX_PART_SOURCING_DETOUR_MINUTES) return noSource;

  // A SKU with no price row is still collectable. A gap in the catalogue is a
  // data problem for whoever maintains prices, not a reason to leave somebody
  // on a roadside, so it contributes zero to the cost rather than blocking.
  let partValuePaise = 0;
  for (const sku of missingSkus) partValuePaise += valuePaiseBySku[sku] ?? 0;

  return {
    status: 'WORKSHOP_RUN',
    detourMinutes: depotRun.detourMinutes,
    partValuePaise,
    depotId: depotRun.depotId,
    missingSkus,
  };
}

// ---------------------------------------------------------------------------
// THE WHOLE FUNCTION, called once per job from candidates.ts.
//
// Async for the same single reason candidate generation is: measuring a
// detour means asking the local road graph how far the depot is. Those two
// extra round trips happen ONLY when some pair is actually short of a part,
// which on an ordinary day is no pair at all.

export type PairForSourcing = {
  unitId: string;
  // Faults this pair's intersected capabilities cover — the answer BEFORE
  // parts are considered.
  skilledFaults: FaultCode[];
  from: LatLng;
  travelMinutesToJob: number;
};

export type PairSourcing = {
  sourcing: PartSourcing;
  // The subset of `skilledFaults` this pair would arrive able to finish. This
  // is what becomes the option's `resolvableFaults`, and dropping a fault out
  // of it is what turns a stockout into capability shortfall risk in cost.ts.
  sourcedFaults: FaultCode[];
};

export async function sourcePartsForPairs(input: {
  job: JobForDispatch;
  parts: PartsSnapshot | null;
  pairs: PairForSourcing[];
  destination: LatLng;
  travelTimes: TravelTimeSource;
}): Promise<PairSourcing[]> {
  const { parts, pairs } = input;

  if (!parts) {
    return pairs.map((pair) => ({ sourcing: NO_PARTS_MODELLED, sourcedFaults: pair.skilledFaults }));
  }

  const availableByUnit = new Map<string, Set<string>>();
  const missingByUnit = new Map<string, string[]>();

  for (const pair of pairs) {
    const available = believableSkus(parts.stock, pair.unitId);
    availableByUnit.set(pair.unitId, available);
    missingByUnit.set(pair.unitId, missingSkusFor(input.job, pair.skilledFaults, available));
  }

  const short = pairs.filter((pair) => (missingByUnit.get(pair.unitId) ?? []).length > 0);
  const detours = await measureDepotRuns({
    parts,
    short,
    destination: input.destination,
    travelTimes: input.travelTimes,
  });

  return pairs.map((pair) => {
    const available = availableByUnit.get(pair.unitId)!;
    const sourcing = decide(
      missingByUnit.get(pair.unitId)!,
      parts.valuePaiseBySku,
      detours.get(pair.unitId) ?? null,
    );

    return {
      sourcing,
      sourcedFaults: pair.skilledFaults.filter((fault) => faultIsSourced(fault, available, sourcing)),
    };
  });
}

// ---------------------------------------------------------------------------
// THE DEPOT RUN, measured on the real road graph.
//
// ONE DEPOT IS CONSIDERED, and it is the one nearest the JOB rather than the
// one nearest each van. That is an approximation and it is deliberate: pricing
// every (van, depot) pair means one road-matrix call per depot per job, and
// the last leg — depot to job — is the one the driver is waiting through, so
// the depot closest to the vehicle is the right one to prefer. Two extra round
// trips, not two per depot.
//
// The detour is what the diversion ADDS: van -> depot -> job, less the trip
// the van was going to make anyway. Clamped at zero, because a depot directly
// on the route can genuinely cost nothing and a negative "detour" would pay a
// crew a bonus for needing a part.
async function measureDepotRuns(input: {
  parts: PartsSnapshot;
  short: PairForSourcing[];
  destination: LatLng;
  travelTimes: TravelTimeSource;
}): Promise<Map<string, { depotId: string; detourMinutes: number }>> {
  const runs = new Map<string, { depotId: string; detourMinutes: number }>();
  const { parts, short } = input;
  if (short.length === 0 || parts.depots.length === 0) return runs;

  const toJob = await input.travelTimes(
    parts.depots.map((depot) => ({ lat: depot.lat, lng: depot.lng })),
    input.destination,
  );

  let nearest = 0;
  for (let index = 1; index < parts.depots.length; index++) {
    if (toJob[index]!.minutes < toJob[nearest]!.minutes) nearest = index;
  }
  const depot = parts.depots[nearest]!;
  const depotToJobMinutes = toJob[nearest]!.minutes;

  const toDepot = await input.travelTimes(
    short.map((pair) => pair.from),
    { lat: depot.lat, lng: depot.lng },
  );

  short.forEach((pair, index) => {
    const added = toDepot[index]!.minutes + depotToJobMinutes - pair.travelMinutesToJob;
    runs.set(pair.unitId, { depotId: depot.id, detourMinutes: Math.max(0, added) });
  });

  return runs;
}
