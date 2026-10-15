// src/engine/destinationSelection.ts — screening, in the order a dispatcher
// would apply it, and the ranking that makes a workshop's own refusal history
// matter. Pure engine tests; no database.

import { describe, expect, it } from 'vitest';
import {
  NO_DESTINATION_NEEDED,
  jobNeedsDestination,
  resolveDestinationForJob,
} from '../src/engine/destinationSelection.js';
import type { WorkshopSnapshot, WorkshopsSnapshot } from '../src/engine/destinationSelection.js';
import { haversineTravelTimes } from '../src/infra/routing.js';
import { FAULT_CODES } from '../src/domain/faults.js';
import type { FaultDistribution } from '../src/domain/faults.js';
import type { JobForDispatch } from '../src/engine/candidates.js';

const NOW = new Date('2026-06-15T10:00:00Z'); // Monday, 15:30 IST — well inside ordinary hours

function distribution(weights: Partial<FaultDistribution>): FaultDistribution {
  const full = {} as FaultDistribution;
  for (const fault of FAULT_CODES) full[fault] = weights[fault] ?? 0;
  return full;
}

const TOW_JOB_BASE: Omit<JobForDispatch, 'vehicleMake' | 'vehicleEvClass'> = {
  id: 'job-1',
  lat: 28.6152,
  lng: 77.2095,
  faultDistribution: distribution({ IMMOBILISED_UNKNOWN: 1 }),
  createdAt: NOW,
  slaResponseMinutes: null,
  contract: null,
  parkingLevel: null,
  onHighway: false,
  safetyLevel: 'NORMAL',
};

function towJob(overrides: Partial<JobForDispatch> = {}): JobForDispatch {
  return { ...TOW_JOB_BASE, vehicleMake: 'MARUTI_SUZUKI', vehicleEvClass: null, ...overrides };
}

function ordinaryJob(): JobForDispatch {
  return { ...towJob(), faultDistribution: distribution({ FLAT_BATTERY: 1 }) };
}

const OPEN_ALL_WEEK = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  opens: '00:00',
  closes: '24:00',
  closed: false,
}));

function workshop(overrides: Partial<WorkshopSnapshot> = {}): WorkshopSnapshot {
  return {
    id: 'ws-1',
    // Defaulted from the id so a fixture that overrides one gets a matching
    // name without every call site having to pass both.
    name: `Workshop ${overrides.id ?? 'ws-1'}`,
    lat: 28.6152,
    lng: 77.2095,
    active: true,
    evClass: null,
    authorisedBrands: ['MARUTI_SUZUKI'],
    hours: OPEN_ALL_WEEK,
    ...overrides,
  };
}

function snapshot(workshops: WorkshopSnapshot[], acceptance: WorkshopsSnapshot['acceptance'] = []): WorkshopsSnapshot {
  return { workshops, acceptance };
}

async function resolve(job: JobForDispatch, workshops: WorkshopsSnapshot | null | undefined) {
  return resolveDestinationForJob({
    job,
    vehicleMake: job.vehicleMake,
    vehicleEvClass: job.vehicleEvClass,
    workshops,
    now: NOW,
    travelTimes: haversineTravelTimes,
  });
}

describe('jobNeedsDestination', () => {
  it('is true for a fault that needs a tow', () => {
    expect(jobNeedsDestination(towJob())).toBe(true);
  });

  it('is false for an ordinary roadside fault', () => {
    expect(jobNeedsDestination(ordinaryJob())).toBe(false);
  });
});

describe('resolveDestinationForJob — the screening pipeline', () => {
  it('is NOT_NEEDED for a job that does not need a tow, without looking at workshops at all', async () => {
    const choice = await resolve(ordinaryJob(), null);
    expect(choice).toEqual(NO_DESTINATION_NEEDED);
  });

  it('is NOT_MODELLED when the snapshot carries no workshop data', async () => {
    const choice = await resolve(towJob(), null);
    expect(choice.status).toBe('NOT_MODELLED');
    expect(choice.pAccept).toBe(1); // no risk to price
  });

  it('is NO_BRAND_MATCH when no active workshop is authorised for this make', async () => {
    const choice = await resolve(
      towJob({ vehicleMake: 'FERRARI' }),
      snapshot([workshop({ authorisedBrands: ['MARUTI_SUZUKI'] })]),
    );
    expect(choice.status).toBe('NO_BRAND_MATCH');
    expect(choice.workshopId).toBeNull();
  });

  it('ignores an inactive workshop even if it is otherwise a perfect match', async () => {
    const choice = await resolve(towJob(), snapshot([workshop({ active: false })]));
    expect(choice.status).toBe('NO_BRAND_MATCH');
  });

  it('is NO_EV_CLASS_MATCH when brand matches but no workshop is equipped for this EV class', async () => {
    const choice = await resolve(
      towJob({ vehicleEvClass: 'HV' }),
      snapshot([workshop({ evClass: null }), workshop({ id: 'ws-2', evClass: 'LV' })]),
    );
    expect(choice.status).toBe('NO_EV_CLASS_MATCH');
  });

  it('an ordinary (non-EV) job is served by a workshop with no EV class at all', async () => {
    const choice = await resolve(towJob({ vehicleEvClass: null }), snapshot([workshop({ evClass: null })]));
    expect(choice.status).toBe('CHOSEN');
  });

  it('an EV job is NOT served by a workshop whose EV class does not match', async () => {
    const choice = await resolve(
      towJob({ vehicleEvClass: 'HV' }),
      snapshot([workshop({ evClass: 'LV' })]),
    );
    expect(choice.status).toBe('NO_EV_CLASS_MATCH');
  });

  it('is NO_DESTINATION_REACHABLE when the only match is closed right now', async () => {
    const closedToday = [{ dayOfWeek: 1, opens: '09:00', closes: '19:00', closed: true }]; // Monday closed
    const choice = await resolve(towJob(), snapshot([workshop({ hours: closedToday })]));
    expect(choice.status).toBe('NO_DESTINATION_REACHABLE');
  });

  it('is CHOSEN when exactly one workshop clears every screen', async () => {
    const choice = await resolve(towJob(), snapshot([workshop()]));
    expect(choice.status).toBe('CHOSEN');
    expect(choice.workshopId).toBe('ws-1');
    expect(choice.screened).toHaveLength(1);
    expect(choice.screened[0]).toMatchObject({ workshopId: 'ws-1', chosen: true });
  });
});

describe('resolveDestinationForJob — the ranking prefers a workshop likely to say yes', () => {
  // Two workshops, roughly comparable distance, one with a real refusal
  // history and one with none (cold start, the prior). The nearer one is
  // ALSO the unreliable one — the case the phase brief's own P(accept) term
  // exists to catch.
  const near = workshop({ id: 'ws-near', lat: 28.6197, lng: 77.214 }); // ~1km from the job
  const farther = workshop({ id: 'ws-far', lat: 28.63, lng: 77.225 }); // ~3km from the job

  it('prefers the closer workshop when nothing distinguishes their acceptance history', async () => {
    const choice = await resolve(towJob(), snapshot([near, farther]));
    expect(choice.workshopId).toBe('ws-near');
  });

  it('prefers the more reliable workshop once its refusal history is bad enough to outweigh the distance', async () => {
    const acceptance = [
      // ws-near declines constantly.
      { workshopId: 'ws-near', hourBucket: 'MORNING' as const, vehicleClass: 'NONE' as const, accepted: 0, refused: 50 },
      // ws-far accepts constantly.
      { workshopId: 'ws-far', hourBucket: 'MORNING' as const, vehicleClass: 'NONE' as const, accepted: 50, refused: 0 },
    ];
    const morning = new Date('2026-06-15T04:00:00Z'); // 09:30 IST — MORNING bucket

    const choice = await resolveDestinationForJob({
      job: towJob(),
      vehicleMake: 'MARUTI_SUZUKI',
      vehicleEvClass: null,
      workshops: snapshot([near, farther], acceptance),
      now: morning,
      travelTimes: haversineTravelTimes,
    });

    expect(choice.workshopId).toBe('ws-far');
    expect(choice.screened.find((row) => row.workshopId === 'ws-near')?.pAccept).toBeLessThan(0.2);
    expect(choice.screened.find((row) => row.workshopId === 'ws-far')?.pAccept).toBeGreaterThan(0.9);
  });

  it('reads a different bucket at a different hour for the same workshop', async () => {
    const acceptance = [
      { workshopId: 'ws-near', hourBucket: 'EVENING' as const, vehicleClass: 'NONE' as const, accepted: 0, refused: 50 },
    ];
    const evening = new Date('2026-06-15T13:00:00Z'); // 18:30 IST — EVENING bucket
    const morning = new Date('2026-06-15T04:00:00Z'); // 09:30 IST — MORNING bucket, no data for this cell

    const eveningChoice = await resolveDestinationForJob({
      job: towJob(),
      vehicleMake: 'MARUTI_SUZUKI',
      vehicleEvClass: null,
      workshops: snapshot([near], acceptance),
      now: evening,
      travelTimes: haversineTravelTimes,
    });
    const morningChoice = await resolveDestinationForJob({
      job: towJob(),
      vehicleMake: 'MARUTI_SUZUKI',
      vehicleEvClass: null,
      workshops: snapshot([near], acceptance),
      now: morning,
      travelTimes: haversineTravelTimes,
    });

    // Same workshop, same job, only the hour differs — the evening cell has
    // real refusal history and the morning cell falls back to the prior.
    expect(eveningChoice.pAccept).toBeLessThan(0.2);
    expect(morningChoice.pAccept).toBeGreaterThan(0.7);
    expect(eveningChoice.pAccept).toBeLessThan(morningChoice.pAccept);
  });
});

// ---------------------------------------------------------------------------
// THE SCREENING AUDIT LIST — what the why-inspector's destination panel shows.
//
// These assert the thing Phase 22b's audit found missing: not WHICH workshop
// won, which the tests above already cover, but whether the panel can explain
// the ones that lost. The distinction that matters is between a workshop that
// may not touch this car at all and one that simply lost on distance — the old
// list could not express it because it only ever held the priced shortlist.
//
// Nothing here asserts a decision. `status`, `workshopId` and `pAccept` are the
// decision and are covered above; this is about the audit trail beside it.

describe('resolveDestinationForJob — the screening audit list', () => {
  it('lists a brand-excluded workshop with its own reason, in the case where nothing was chosen', async () => {
    const choice = await resolve(
      towJob({ vehicleMake: 'FERRARI' }),
      snapshot([workshop({ id: 'ws-maruti', authorisedBrands: ['MARUTI_SUZUKI'] })]),
    );

    // The panel used to render nothing at all here — status was not CHOSEN, so
    // it returned early, and `screened` was empty anyway.
    expect(choice.status).toBe('NO_BRAND_MATCH');
    expect(choice.screened).toHaveLength(1);
    expect(choice.screened[0]).toMatchObject({
      workshopId: 'ws-maruti',
      name: 'Workshop ws-maruti',
      excludedBy: 'BRAND_NOT_AUTHORISED',
      chosen: false,
      // Never priced, so never given a distance it did not have.
      distanceKm: null,
      pAccept: null,
    });
  });

  it('keeps the brand and EV-class exclusions distinct rather than collapsing them', async () => {
    const choice = await resolve(
      towJob({ vehicleMake: 'TATA', vehicleEvClass: 'HV' }),
      snapshot([
        workshop({ id: 'ws-wrong-brand', authorisedBrands: ['MARUTI_SUZUKI'] }),
        workshop({ id: 'ws-no-ev', authorisedBrands: ['TATA'], evClass: null }),
      ]),
    );

    expect(choice.status).toBe('NO_EV_CLASS_MATCH');
    const byId = new Map(choice.screened.map((row) => [row.workshopId, row.excludedBy]));
    // "Authorised for the brand but not equipped for EVs" is a different
    // finding from "does not touch this brand", and a dispatcher acts on them
    // differently — the same reason feasibility.ts keeps two codes.
    expect(byId.get('ws-wrong-brand')).toBe('BRAND_NOT_AUTHORISED');
    expect(byId.get('ws-no-ev')).toBe('EV_CLASS_MISMATCH');
  });

  it('reports a closed workshop as closed rather than as unauthorised', async () => {
    const shut = workshop({
      id: 'ws-shut',
      hours: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        opens: '09:00',
        closes: '17:00',
        closed: true,
      })),
    });

    const choice = await resolve(towJob(), snapshot([shut]));
    expect(choice.status).toBe('NO_DESTINATION_REACHABLE');
    expect(choice.screened[0]?.excludedBy).toBe('CLOSED_NOW');
  });

  it('marks the winner chosen and prices it, alongside an excluded workshop, on a resolved job', async () => {
    const choice = await resolve(
      towJob(),
      snapshot([
        workshop({ id: 'ws-ok', lat: 28.6152, lng: 77.2095 }),
        workshop({ id: 'ws-other-brand', authorisedBrands: ['HYUNDAI'] }),
      ]),
    );

    expect(choice.status).toBe('CHOSEN');
    expect(choice.workshopId).toBe('ws-ok');

    // BOTH rows are present — the excluded one is exactly what the panel was
    // missing when it rendered only the priced shortlist.
    expect(choice.screened).toHaveLength(2);
    const winner = choice.screened.find((row) => row.workshopId === 'ws-ok');
    expect(winner).toMatchObject({ chosen: true, excludedBy: null });
    expect(typeof winner?.distanceKm).toBe('number');
    expect(typeof winner?.pAccept).toBe('number');
    expect(choice.screened.find((row) => row.workshopId === 'ws-other-brand')).toMatchObject({
      chosen: false,
      excludedBy: 'BRAND_NOT_AUTHORISED',
    });
  });

  it('does not list an inactive workshop at all — it is not part of the network today', async () => {
    const choice = await resolve(
      towJob(),
      snapshot([workshop({ id: 'ws-ok' }), workshop({ id: 'ws-gone', active: false })]),
    );
    expect(choice.screened.map((row) => row.workshopId)).toEqual(['ws-ok']);
  });

  it('separates "cleared screening but further away" from a real exclusion', async () => {
    // Five eligible workshops, a shortlist of four: the fifth cleared every
    // screen and was never priced, which must not read as a rejection.
    const eligible = [0, 1, 2, 3, 4].map((index) =>
      workshop({ id: `ws-${index}`, lat: 28.6152 + index * 0.05, lng: 77.2095 }),
    );

    const choice = await resolve(towJob(), snapshot(eligible));
    expect(choice.status).toBe('CHOSEN');

    const notShortlisted = choice.screened.filter((row) => row.excludedBy === 'NOT_SHORTLISTED');
    expect(notShortlisted).toHaveLength(1);
    expect(notShortlisted[0]?.workshopId).toBe('ws-4');
    // No screening code — it failed nothing, it was just further out.
    expect(choice.screened.every((row) => row.excludedBy !== 'BRAND_NOT_AUTHORISED')).toBe(true);
  });
});
