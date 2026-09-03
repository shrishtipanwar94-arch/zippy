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
  // Audit only. Nothing in this file's decisions reads it — it exists so the
  // why-inspector can name a workshop instead of showing its id.
  name: string;
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

// WHY A WORKSHOP WAS OR WAS NOT USED — one row per active workshop, whether it
// survived screening or not.
//
// THIS USED TO BE THE SHORTLIST ONLY, and that was the bug Phase 22b's audit
// found. Every row was one that had already cleared brand, EV class and hours,
// so a ✕ in the panel meant "not the cheapest" and there was no way at all to
// see the workshop that was excluded because it does not touch this brand —
// which is the single most useful thing the panel could say. "Authorised for
// Maruti but not equipped for EVs" is precisely what Phase 22 built the
// screening pipeline to distinguish, and none of it reached a screen.
//
// So a row now carries WHICH SCREEN it failed, and the two authorisation codes
// stay distinct rather than collapsing into "not authorised" — feasibility.ts
// keeps them apart for the same reason (see its own comment at the top).
//
// STILL AUDIT DETAIL, NEVER A DECISION INPUT. cost.ts and feasibility.ts read
// `status`, `workshopId` and `pAccept` on the choice itself; nothing reads this
// list. Adding to it cannot change a dispatch.
export const SCREENING_EXCLUSIONS = [
  'BRAND_NOT_AUTHORISED',
  'EV_CLASS_MISMATCH',
  'CLOSED_NOW',
  // Cleared every screen but did not make the distance shortlist. Not a
  // rejection — just further away than the four that were priced.
  'NOT_SHORTLISTED',
] as const;

export type ScreeningExclusion = (typeof SCREENING_EXCLUSIONS)[number];

export type ScreenedWorkshop = {
  workshopId: string;
  name: string;
  // Null for anything that never reached the routing call. A workshop excluded
  // on brand has no measured road distance, and inventing a straight-line one
  // for the panel would put a number next to a row that was never priced.
  distanceKm: number | null;
  pAccept: number | null;
  chosen: boolean;
  // Null when the workshop cleared every screen and was priced.
  excludedBy: ScreeningExclusion | null;
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
  // EVERY ACTIVE WORKSHOP AND WHAT BECAME OF IT, for the why-inspector's
  // screening panel — populated for CHOSEN and for all three unresolved
  // statuses, because "nowhere was authorised" is the case a dispatcher most
  // needs the list for. Empty only for NOT_NEEDED and NOT_MODELLED, where no
  // screening happened at all. Never read by cost.ts or feasibility.ts: both
  // act on `workshopId` and `pAccept` above, which already carry the decision.
  // This is audit detail, the same role `partSourcing.missingSkus` plays for
  // parts.
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
function unresolved(
  status: 'NO_BRAND_MATCH' | 'NO_EV_CLASS_MATCH' | 'NO_DESTINATION_REACHABLE',
  detail: string,
  screened: ScreenedWorkshop[],
): DestinationChoice {
  return { status, workshopId: null, distanceKm: 0, pAccept: 0, detail, screened };
}

// WHICH SCREEN EACH ACTIVE WORKSHOP FAILED, in the pipeline's own order, so the
// first failure is the one reported: a workshop that is neither authorised for
// the brand NOR open reads as a brand problem, which is the one a dispatcher
// can actually do something about.
//
// This DECIDES NOTHING. It re-states the same three predicates the resolve
// function filters on, over the same list, so a row's verdict here and its
// presence downstream cannot disagree.
function exclusionFor(
  workshop: WorkshopSnapshot,
  vehicleMake: string,
  vehicleEvClass: string | null,
  now: Date,
): ScreeningExclusion | null {
  if (!workshop.authorisedBrands.includes(vehicleMake)) return 'BRAND_NOT_AUTHORISED';
  if (!evCompatible(workshop.evClass, vehicleEvClass)) return 'EV_CLASS_MISMATCH';
  if (!isWorkshopOpen(workshop.hours, now)) return 'CLOSED_NOW';
  return null;
}

// Every active workshop as a panel row. `priced` is empty in the unresolved
// cases, which is what makes this one function rather than two: a row with no
// price is a row that never reached the routing call, however far it got.
function screeningRows(
  active: WorkshopSnapshot[],
  priced: { workshopId: string; distanceKm: number; pAccept: number }[],
  chosenId: string | null,
  vehicleMake: string,
  vehicleEvClass: string | null,
  now: Date,
): ScreenedWorkshop[] {
  const pricedById = new Map(priced.map((row) => [row.workshopId, row]));

  return active.map((workshop) => {
    const price = pricedById.get(workshop.id);
    const excluded = exclusionFor(workshop, vehicleMake, vehicleEvClass, now);
    return {
      workshopId: workshop.id,
      name: workshop.name,
      distanceKm: price?.distanceKm ?? null,
      pAccept: price?.pAccept ?? null,
      chosen: workshop.id === chosenId,
      // Cleared every screen but was not priced: it lost the distance
      // shortlist, which is not a rejection and must not read as one.
      excludedBy: excluded ?? (price ? null : 'NOT_SHORTLISTED'),
    };
  });
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

  // The screening rows every return below carries. Built once, from the same
  // predicates the filters use, and empty of prices until there are any.
  const rows = () => screeningRows(active, [], null, vehicleMake, vehicleEvClass, now);

  const brandMatched = active.filter((workshop) => workshop.authorisedBrands.includes(vehicleMake));
  if (brandMatched.length === 0) {
    return unresolved('NO_BRAND_MATCH', `no active workshop is authorised for ${vehicleMake}`, rows());
  }

  const evMatched = brandMatched.filter((workshop) => evCompatible(workshop.evClass, vehicleEvClass));
  if (evMatched.length === 0) {
    return unresolved(
      'NO_EV_CLASS_MATCH',
      `authorised for ${vehicleMake} but none equipped for ${vehicleEvClass} vehicles`,
      rows(),
    );
  }

  const openNow = evMatched.filter((workshop) => isWorkshopOpen(workshop.hours, now));
  if (openNow.length === 0) {
    return unresolved(
      'NO_DESTINATION_REACHABLE',
      `${evMatched.length} authorised and equipped workshop(s) exist, none open at this hour`,
      rows(),
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
    // EVERY active workshop, not just the four that were priced — see
    // ScreenedWorkshop's own comment for why the shortlist alone was the bug.
    screened: screeningRows(active, priced, chosen.workshopId, vehicleMake, vehicleEvClass, now),
  };
}
