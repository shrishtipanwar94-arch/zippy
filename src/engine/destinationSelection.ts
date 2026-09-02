// WHERE A TOW GOES — resolved ONCE PER JOB, not once per pair, and that
// difference from partSourcing.ts is the point worth stating first.
//
// Parts sourcing collapses to one answer PER PAIR because what is on a van
// differs by which van it is. A workshop choice has no such dependency: it is
// a function of the JOB — its vehicle's brand and EV class, its location, the
// hour of day — and none of those change with which unit or technician ends
// up sent. So this file resolves a single DestinationChoice for the job and
// every option for that job carries the SAME one. The matrix still does not
// grow — it never had a reason to.
//
// THE SCREENING PIPELINE, in the order a real dispatcher would apply it:
//   1. brand authorisation      — does this workshop touch this make at all
//   2. EV class                 — a SEPARATE question from brand: authorised
//                                  for Maruti does not mean equipped for EVs
//   3. open right now            — WorkshopHours, in IST
//   4. reachable                 — real road distance, cheapest-first
//   5. likely to say yes         — the learned P(accept), a tie-break and a
//                                  genuine factor, never a hard filter
// Each layer that eliminates every remaining candidate produces its own
// reason code — src/engine/feasibility.ts reads `status` and turns it into
// one of DESTINATION_NOT_AUTHORISED, DESTINATION_EV_CLASS_MISMATCH or
// NO_DESTINATION_AVAILABLE.
//
// Zero imports from prisma or redis, the same rule as every /src/engine file.

import { distanceKm } from '../domain/geo.js';
import { isWorkshopOpen } from '../domain/workshopHours.js';
import type { WorkshopHoursRow } from '../domain/workshopHours.js';
import {
  acceptanceBucketKey,
  betaAcceptMean,
  hourBucketFor,
  vehicleClassFor,
} from '../domain/workshopAcceptance.js';
import type { HourBucket, VehicleClass } from '../domain/workshopAcceptance.js';
import { faultsNeedTow } from '../domain/capabilitySet.js';
import type { JobForDispatch } from './candidates.js';
import type { TravelTimeSource } from '../infra/routing.js';

// ---------------------------------------------------------------------------
// Input: the workshop half of a dispatch snapshot. Plain data, read out of
// Postgres by src/commit/dispatchSnapshot.ts, exactly like the parts half.

export type WorkshopSnapshot = {
  id: string;
  lat: number;
  lng: number;
  active: boolean;
  // null | 'LV' | 'HV', mirroring Workshop.evClass exactly — see
  // src/domain/workshopAcceptance.ts's vehicleClassFor for the same
  // vocabulary read from the vehicle's side.
  evClass: string | null;
  authorisedBrands: string[];
  hours: WorkshopHoursRow[];
};

// One (workshop, hour bucket, vehicle class) cell's raw counts. The estimate
// itself is computed here, not stored — the same "never cache a derivable
// figure" rule src/commit/ledger.ts's accountBalance follows.
export type WorkshopAcceptanceCell = {
  workshopId: string;
  hourBucket: HourBucket;
  vehicleClass: VehicleClass;
  accepted: number;
  refused: number;
};

export type WorkshopsSnapshot = {
  workshops: WorkshopSnapshot[];
  acceptance: WorkshopAcceptanceCell[];
};

// ---------------------------------------------------------------------------
// The single destination decision carried on every DispatchOption for a job.

export const DESTINATION_STATUSES = [
  // Not a tow job. The overwhelming majority of options, every day.
  'NOT_NEEDED',
  // This snapshot does not model workshops at all — the same "we did not
  // look" meaning NOT_MODELLED carries in partSourcing.ts, and for the same
  // reason: never rejects, and must not be read as "no workshop exists".
  'NOT_MODELLED',
  'CHOSEN',
  // Three ways screening can come back empty, each its own reason —
  // src/engine/feasibility.ts maps these onto the three destination codes.
  'NO_BRAND_MATCH',
  'NO_EV_CLASS_MATCH',
  'NO_DESTINATION_REACHABLE',
] as const;

export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

// One shortlisted workshop, screened and priced — what the why-inspector's
// destination panel renders as a row. Every entry already cleared brand,
// EV class and opening hours; what differs between them is only distance and
// P(accept), which is exactly what the panel is for showing.
export type ScreenedWorkshop = {
  workshopId: string;
  distanceKm: number;
  pAccept: number;
  chosen: boolean;
};

export type DestinationChoice = {
  status: DestinationStatus;
  workshopId: string | null;
  distanceKm: number;
  // 1 for NOT_NEEDED and NOT_MODELLED — there is no workshop being risked, so
  // the refusal-risk cost term (src/engine/cost.ts) must contribute nothing
  // rather than a value nobody computed anything from.
  pAccept: number;
  detail: string;
  // ONLY FOR CHOSEN — the shortlist the winner was picked from, for the
  // why-inspector's screening panel. Never read by cost.ts or feasibility.ts:
  // both act on `workshopId` and `pAccept` above, which already carry the
  // decision. This is audit detail, the same role `partSourcing.missingSkus`
  // plays for parts.
  screened: ScreenedWorkshop[];
};

export const NO_DESTINATION_NEEDED: DestinationChoice = {
  status: 'NOT_NEEDED',
  workshopId: null,
  distanceKm: 0,
  pAccept: 1,
  detail: 'not a tow job',
  screened: [],
};

const NOT_MODELLED: DestinationChoice = {
  status: 'NOT_MODELLED',
  workshopId: null,
  distanceKm: 0,
  pAccept: 1,
  detail: 'this snapshot does not model workshops',
  screened: [],
};

// A tow job with no workshop chosen prices as an ordinary detour would if it
// somehow reached the cost function — but it never does, because feasibility
// rejects every one of these three statuses. distanceKm and pAccept are
// unread in that path; kept at honest, inert values rather than omitted.
function unresolved(status: 'NO_BRAND_MATCH' | 'NO_EV_CLASS_MATCH' | 'NO_DESTINATION_REACHABLE', detail: string): DestinationChoice {
  return { status, workshopId: null, distanceKm: 0, pAccept: 0, detail, screened: [] };
}

// A tow job needs a workshop to be towed to, and "needs a tow" is exactly the
// FLATBED_LOADING / WINCH_RECOVERY test feasibility.ts uses to require a
// tow-capable unit. src/domain/capabilitySet.ts owns that capability list so
// the destination screen and the feasibility filter cannot drift apart.
export function jobNeedsDestination(job: JobForDispatch): boolean {
  return faultsNeedTow(job.faultDistribution);
}

// null (not an EV) matches ANY workshop's own evClass — EV certification is
// an ADD-ON a workshop carries alongside ordinary GENERAL_REPAIR, never an
// exclusive specialism that locks out ordinary vehicles. An EV job needs the
// workshop's own evClass to match its own exactly.
function evCompatible(workshopEvClass: string | null, jobVehicleEvClass: string | null): boolean {
  if (jobVehicleEvClass === null) return true;
  return workshopEvClass === jobVehicleEvClass;
}

// Straight-line distance is cheap (no I/O) and there are only ever a handful
// of workshops citywide, so every candidate can be measured this way before
// deciding which few are worth a real routing call.
const MAX_DESTINATION_SHORTLIST = 4;

// How much distance a dispatcher would trade for a workshop more likely to
// say yes — the same shape a highway detour ratio or a part-sourcing detour
// cap takes elsewhere in this project: a hand-set number that converts one
// quantity into the units of another, named so it can be argued with. A
// workshop half as likely to accept has to be more than 3km closer to still
// win the comparison.
const REFUSAL_DISTANCE_PENALTY_KM = 6;

function countsFor(
  cells: WorkshopAcceptanceCell[],
  workshopId: string,
  hourBucket: HourBucket,
  vehicleClass: VehicleClass,
): { accepted: number; refused: number } {
  // Match on the one key format src/domain/workshopAcceptance.ts owns, the
  // same call src/commit/dispatchSnapshot.ts builds the cells under, so the
  // reader and the builder cannot disagree about the string.
  const wanted = acceptanceBucketKey(workshopId, hourBucket, vehicleClass);
  const cell = cells.find(
    (candidate) => acceptanceBucketKey(candidate.workshopId, candidate.hourBucket, candidate.vehicleClass) === wanted,
  );
  return cell ? { accepted: cell.accepted, refused: cell.refused } : { accepted: 0, refused: 0 };
}

// ---------------------------------------------------------------------------
// THE WHOLE FUNCTION, called once per job from candidates.ts — never per
// pair. Async for the same reason measureDepotRuns is: a real distance means
// asking the road graph, and that only happens for the shortlist, not every
// workshop in the fleet.
export async function resolveDestinationForJob(input: {
  job: JobForDispatch;
  vehicleMake: string;
  vehicleEvClass: string | null;
  workshops: WorkshopsSnapshot | null | undefined;
  now: Date;
  travelTimes: TravelTimeSource;
}): Promise<DestinationChoice> {
  const { job, vehicleMake, vehicleEvClass, workshops, now, travelTimes } = input;

  if (!jobNeedsDestination(job)) return NO_DESTINATION_NEEDED;
  if (!workshops) return NOT_MODELLED;

  const active = workshops.workshops.filter((workshop) => workshop.active);

  const brandMatched = active.filter((workshop) => workshop.authorisedBrands.includes(vehicleMake));
  if (brandMatched.length === 0) {
    return unresolved('NO_BRAND_MATCH', `no active workshop is authorised for ${vehicleMake}`);
  }

  const evMatched = brandMatched.filter((workshop) => evCompatible(workshop.evClass, vehicleEvClass));
  if (evMatched.length === 0) {
    return unresolved(
      'NO_EV_CLASS_MATCH',
      `authorised for ${vehicleMake} but none equipped for ${vehicleEvClass} vehicles`,
    );
  }

  const openNow = evMatched.filter((workshop) => isWorkshopOpen(workshop.hours, now));
  if (openNow.length === 0) {
    return unresolved(
      'NO_DESTINATION_REACHABLE',
      `${evMatched.length} authorised and equipped workshop(s) exist, none open at this hour`,
    );
  }

  // Cheapest-first shortlist by straight-line distance — no I/O yet.
  const shortlist = openNow
    .map((workshop) => ({ workshop, straightKm: distanceKm(job.lat, job.lng, workshop.lat, workshop.lng) }))
    .sort((a, b) => a.straightKm - b.straightKm)
    .slice(0, MAX_DESTINATION_SHORTLIST);

  // A tow drives FROM the job TO the workshop, so the distance that ranks the
  // shortlist and lands in the audit record has to be measured in that
  // direction — OSRM's graph encodes one-way roads and dividers, so job -> ws
  // and ws -> job are not the same number. TravelTimeSource takes many origins
  // and one destination, which is the wrong shape for one origin (the job) and
  // several destinations, so the shortlist — already down to four — gets one
  // call each, run in parallel, rather than a single matrix call backwards.
  const jobOrigin = [{ lat: job.lat, lng: job.lng }];
  const real = await Promise.all(
    shortlist.map(async (entry) => {
      const [estimate] = await travelTimes(jobOrigin, { lat: entry.workshop.lat, lng: entry.workshop.lng });
      return estimate!;
    }),
  );

  const bucket = hourBucketFor(now);
  const vehicleClass = vehicleClassFor(vehicleEvClass);

  const priced = shortlist.map((entry, index) => {
    const estimate = real[index]!;
    const pAccept = betaAcceptMean(countsFor(workshops.acceptance, entry.workshop.id, bucket, vehicleClass));
    const score = estimate.kilometres + REFUSAL_DISTANCE_PENALTY_KM * (1 - pAccept);
    return { workshopId: entry.workshop.id, distanceKm: estimate.kilometres, pAccept, score };
  });

  let chosen = priced[0]!;
  for (const candidate of priced) {
    if (candidate.score < chosen.score) chosen = candidate;
  }

  return {
    status: 'CHOSEN',
    workshopId: chosen.workshopId,
    distanceKm: chosen.distanceKm,
    pAccept: chosen.pAccept,
    detail: `authorised for ${vehicleMake}${vehicleClass === 'NONE' ? '' : `, ${vehicleClass} equipped`}`,
    screened: priced.map((candidate) => ({
      workshopId: candidate.workshopId,
      distanceKm: candidate.distanceKm,
      pAccept: candidate.pAccept,
      chosen: candidate.workshopId === chosen.workshopId,
    })),
  };
}
