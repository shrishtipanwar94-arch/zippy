// THE DRIVER SURFACE — the phase check, written down.
//
// "Open the driver view and read it as a stranger. Any SCREAMING_CASE word is
// a bug." That is a claim about a rendered page, and a claim about a page is
// not testable. It becomes testable because the translation happens on the
// SERVER (src/api/driver.ts): the page renders strings it is handed, so if the
// response body contains no enum, the page cannot show one.
//
// So the central test here scans the WHOLE response body — every string at
// every depth — for a SCREAMING_CASE token, and fails naming the offender.
// That catches the mistake this phase is most likely to make: a later change
// adding a field that passes an enum straight through.
//
// The rest is the pure layer: the ladder's monotonic advance, and the fact that
// the guidance card cannot be situation-specific because it has no situation to
// be specific about.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/api/app.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import { issueAccessToken } from '../src/auth/tokens.js';
import { headlineFor, whatWeThinkItIs } from '../src/domain/driverNarrative.js';
import { guidanceFor } from '../src/domain/safetyGuidance.js';
import { ladderMove, nextStepFor, LADDER_STEPS } from '../src/domain/jobLadder.js';
import { driverUpdatesFor } from '../src/domain/driverUpdates.js';
import { answerOptions, hasAnswerLabel } from '../src/domain/answerLabels.js';
import { INTAKE_QUESTIONS } from '../src/domain/questions.js';
import type { JobStatus, SafetyLevel } from '@prisma/client';

const app = createApp();

// Every row this file creates carries this prefix. Nothing here counts rows in
// a shared table — `zippy_test` is shared by every suite and vitest runs files
// in parallel, so an assertion phrased about the whole database drifts the
// moment another test writes.
const PREFIX = 'drvsurf';
const TENANT = `${PREFIX}-tenant`;

// Every JobStatus. Listed rather than derived from the enum so that adding a
// status to the schema without wording it here fails this file loudly.
const ALL_STATUSES: JobStatus[] = [
  'DRAFT',
  'INTAKE',
  'PLANNED',
  'OFFERED',
  'COMMITTED',
  'EN_ROUTE',
  'ON_SITE',
  'DIAGNOSING',
  'WORKING',
  'AWAITING_DESTINATION',
  'TOWING',
  'RESOLVED',
  'UNSERVICEABLE',
  'CANCELLED',
];

const ALL_LEVELS: SafetyLevel[] = ['NORMAL', 'ELEVATED', 'HIGH_RISK'];

// Two or more capitals with an underscore, or three-plus capitals on their own.
// Deliberately not "any capitalised word": names and the start of a sentence
// are capitals too, and a rule that flags "Finding" catches nothing useful.
const SCREAMING_CASE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z]{3,}\b/;

function driverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-driver-user`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-driver`,
  });
}

function otherDriverToken(): string {
  return issueAccessToken({
    sub: `${PREFIX}-other-user`,
    role: 'DRIVER',
    tenantId: TENANT,
    crossTenant: false,
    actorId: `${PREFIX}-other-driver`,
  });
}

let jobId = '';

beforeAll(async () => {
  jobId = await buildFixture();
});

afterAll(async () => {
  await prismaBase.$disconnect();
});

describe('the translation map — no enum reaches a driver', () => {
  it('has a plain sentence for every job status', () => {
    for (const status of ALL_STATUSES) {
      const sentence = headlineFor({
        status,
        helperName: 'Ravi',
        arrivingAt: new Date('2026-08-31T15:54:00.000Z'),
        replanning: false,
        intakeComplete: true,
      });
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toMatch(SCREAMING_CASE);
      expect(sentence).not.toContain(status);
    }
  });

  it('has a re-planning sentence that names nobody and nothing technical', () => {
    const sentence = headlineFor({
      status: 'DIAGNOSING',
      helperName: 'Ravi',
      arrivingAt: null,
      replanning: true,
      intakeComplete: true,
    });
    expect(sentence).toContain('Ravi');
    expect(sentence).not.toMatch(SCREAMING_CASE);
  });

  it('gives a clock time, never a countdown', () => {
    const sentence = headlineFor({
      status: 'COMMITTED',
      helperName: 'Ravi',
      // 15:54 UTC is 21:24 in Bengaluru — the brief's own example.
      arrivingAt: new Date('2026-08-31T15:54:00.000Z'),
      replanning: false,
      intakeComplete: true,
    });
    expect(sentence).toBe('Ravi is on the way, arriving 21:24.');
  });

  it('says nothing about time when there is no honest estimate', () => {
    const sentence = headlineFor({
      status: 'COMMITTED',
      helperName: 'Ravi',
      arrivingAt: null,
      replanning: false,
      intakeComplete: true,
    });
    expect(sentence).toBe('Ravi is on the way to you now.');
  });

  // A job sits at INTAKE from the last answer until the solver plans it. During
  // that window the old sentence said we were still taking down details, above
  // a feed line already saying we had everything we needed.
  it('stops saying it is still taking details once intake has finished', () => {
    const asking = headlineFor({
      status: 'INTAKE',
      helperName: null,
      arrivingAt: null,
      replanning: false,
      intakeComplete: false,
    });
    const finished = headlineFor({
      status: 'INTAKE',
      helperName: null,
      arrivingAt: null,
      replanning: false,
      intakeComplete: true,
    });
    expect(asking).toBe('We are taking down the details of your breakdown.');
    expect(finished).toBe('Finding someone equipped for this.');
  });

  it('admits uncertainty instead of naming one fault', () => {
    const sentence = whatWeThinkItIs(['FLAT_BATTERY', 'ALTERNATOR_FAILURE']);
    expect(sentence).toBe(
      'We are not certain whether it is a flat battery or the alternator, so we are sending someone equipped for both.',
    );
    expect(sentence).not.toMatch(SCREAMING_CASE);
  });

  // THE WHITELIST. An event type with no sentence produces nothing rather than
  // echoing itself, which is what stops a later phase leaking a new event type
  // onto this surface.
  it('drops an event it has no sentence for rather than echoing it', () => {
    const updates = driverUpdatesFor([
      { eventType: 'JOB_CREATED', at: new Date() },
      { eventType: 'SOME_FUTURE_PHASE_EVENT', at: new Date() },
    ]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.text).not.toMatch(SCREAMING_CASE);
  });
});

// The answer buttons were the fourth leak the browser walk-through found: four
// buttons reading CLICKING, GRINDING, SILENCE, OTHER. A missing label is a
// build failure rather than a fallback, because a driver cannot answer a
// question whose answers were dropped.
describe('the intake answer buttons', () => {
  it('has words for every answer of every question', () => {
    const unworded: string[] = [];
    for (const question of INTAKE_QUESTIONS) {
      for (const answer of question.answers) {
        if (!hasAnswerLabel(answer)) unworded.push(`${question.code}/${answer}`);
      }
    }
    expect(unworded).toEqual([]);
  });

  it('words them without an enum in sight, and keeps the code for the API', () => {
    const options = answerOptions(['CLICKING', 'GRINDING', 'SILENCE', 'OTHER']);
    expect(options.map((option) => option.value)).toEqual([
      'CLICKING',
      'GRINDING',
      'SILENCE',
      'OTHER',
    ]);
    for (const option of options) expect(option.label).not.toMatch(SCREAMING_CASE);
  });

  it('words every prompt without an enum either', () => {
    for (const question of INTAKE_QUESTIONS) {
      expect(question.prompt).not.toMatch(SCREAMING_CASE);
    }
  });
});

describe('the while-you-wait card', () => {
  // The single most important property of this function is its ARITY. The
  // brief says the guidance must be generic and conservative, never diagnostic;
  // taking only a safety level is what makes that structural rather than a
  // convention somebody can drift away from.
  it('takes a safety level and nothing else', () => {
    expect(guidanceFor.length).toBe(1);
  });

  it('gives the same advice for a level however the job got there', () => {
    for (const level of ALL_LEVELS) {
      expect(guidanceFor(level)).toEqual(guidanceFor(level));
      expect(guidanceFor(level).points.length).toBeGreaterThan(0);
      for (const point of guidanceFor(level).points) {
        expect(point).not.toMatch(SCREAMING_CASE);
      }
    }
  });

  it('escalates without ever mentioning the vehicle', () => {
    const highRisk = guidanceFor('HIGH_RISK');
    expect(highRisk.points.join(' ')).toMatch(/away from moving traffic/i);
    // Never diagnostic, never predictive about the vehicle.
    expect(highRisk.points.join(' ')).not.toMatch(/battery|alternator|engine|tyre/i);
  });
});

describe('the status ladder', () => {
  it('only ever moves a job forward', () => {
    // Arriving twice is the replay case and must be a no-op, not a second
    // transition.
    expect(ladderMove('ON_SITE', 'ARRIVED').outcome).toBe('ALREADY_PAST');
    expect(ladderMove('WORKING', 'EN_ROUTE').outcome).toBe('ALREADY_PAST');
  });

  it('closes a gap left by an action that never arrived', () => {
    // "On my way" was lost; "arrived" still has to work.
    const move = ladderMove('COMMITTED', 'ARRIVED');
    expect(move.outcome).toBe('ADVANCE');
    if (move.outcome !== 'ADVANCE') return;
    expect(move.to).toBe('ON_SITE');
    // The conditional UPDATE names every status below the target, which is
    // what makes the write safe when two devices arrive at once.
    expect(move.from).toContain('COMMITTED');
    expect(move.from).toContain('EN_ROUTE');
    expect(move.from).not.toContain('WORKING');
  });

  it('refuses a job that is not on the ladder at all', () => {
    expect(ladderMove('CANCELLED', 'ARRIVED').outcome).toBe('OFF_LADDER');
    expect(ladderMove('PLANNED', 'EN_ROUTE').outcome).toBe('OFF_LADDER');
  });

  it('offers each rung in turn and then stops', () => {
    expect(nextStepFor('COMMITTED')).toBe(LADDER_STEPS[0]);
    expect(nextStepFor('WORKING')).toBe('COMPLETE');
    expect(nextStepFor('RESOLVED')).toBeNull();
    expect(nextStepFor('CANCELLED')).toBeNull();
  });
});

// THE MARKUP AND THE PANELS — the half the API scan cannot see.
//
// The response body is only one of the things on the driver's screen. The page
// also has its own copy in driver.html, and the panels it registers can put
// their own strings on screen. Walking the page in a real browser found two
// leaks that had nothing to do with the API: the shared header rendering
// "DRIVER · user-driver-metrocab-1", and the intake panel rendering
// "Intake complete: ENTROPY_BELOW_THRESHOLD".
//
// These two assertions are what stops both coming back. They are narrower than
// the API scan — they check the markup and one panel, not everything a browser
// could render — and that limit is recorded rather than papered over.
describe('the driver page itself', () => {
  it('has no SCREAMING_CASE in anything it displays', () => {
    const html = readFileSync(join('public', 'driver.html'), 'utf8')
      // Comments first: this file's own comments discuss enums on purpose.
      .replace(/<!--[\s\S]*?-->/g, '')
      // Then the tags, which takes every attribute with them — the complaint
      // buttons legitimately carry enum VALUES, and a driver never sees one.
      .replace(/<[^>]+>/g, ' ');

    // The matched WORDS, not the lines, so a failure names the offender.
    const offenders = html.match(new RegExp(SCREAMING_CASE.source, 'g')) ?? [];
    expect(offenders).toEqual([]);
  });

  it('does not put the intake stop reason on screen', () => {
    const source = readFileSync(join('public', 'js', 'panels', 'intake.js'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    // The reason code is a stop condition — dispatcher detail. It is still
    // recorded, in the INTAKE_COMPLETED event the console's timeline shows.
    // Using it as a condition is fine — showing the value is not.
    expect(source).not.toMatch(/\$\{[^}]*intakeDone[^}]*\}/);
  });
});

describe('GET /jobs/:id/driver-view', () => {
  it('refuses an unauthenticated caller', async () => {
    expect((await request(app).get(`/jobs/${jobId}/driver-view`)).status).toBe(401);
  });

  // 404, not 403 — a 403 would confirm the job exists.
  it('hides another driver’s job behind a 404', async () => {
    const response = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${otherDriverToken()}`);
    expect(response.status).toBe(404);
  });

  // THE PHASE CHECK. Every string in the payload, at every depth.
  it('contains no SCREAMING_CASE anywhere in the response', async () => {
    const response = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(response.status).toBe(200);
    const offenders = screamingStrings(response.body);
    expect(offenders).toEqual([]);
  });

  it('shows the itemised cost, and the completion code after it', async () => {
    const response = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken()}`);

    expect(response.body.estimate.lines).toEqual([
      { description: 'Drive belt', amount: '₹640' },
      { description: 'Labour, one hour', amount: '₹800' },
    ]);
    expect(response.body.estimate.total).toBe('₹1,440');

    // Grouped in threes because it is read aloud once, next to a running road.
    expect(response.body.completionCode.code).toBe('482 913');

    // The ORDER is the promise: cost before the code that confirms the work.
    const keys = Object.keys(response.body);
    expect(keys.indexOf('estimate')).toBeLessThan(keys.indexOf('completionCode'));
  });

  it('tells the story in plain sentences, oldest first', async () => {
    const response = await request(app)
      .get(`/jobs/${jobId}/driver-view`)
      .set('Authorization', `Bearer ${driverToken()}`);

    const texts = response.body.updates.map((update: { text: string }) => update.text);
    expect(texts[0]).toBe('We received your breakdown report.');
    expect(texts).toContain('Your technician has arrived.');
  });
});

// Walks the whole payload and returns every string containing a SCREAMING_CASE
// token, with the path it was found at — a bare `expect(json).not.toMatch()`
// would fail without saying which field is wrong.
function screamingStrings(value: unknown, path = ''): string[] {
  if (typeof value === 'string') {
    return SCREAMING_CASE.test(value) ? [`${path}: ${value}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => screamingStrings(item, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      screamingStrings(child, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

// ---------------------------------------------------------------------------
// One job on scene, with a technician, an estimate and a completion code —
// enough for every field of the response to be non-null at once, because a
// null field cannot leak an enum and the test would pass for the wrong reason.

async function buildFixture(): Promise<string> {
  await prismaBase.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: 'Driver Surface Tenant', kind: 'FLEET' },
  });
  await prismaBase.zone.upsert({
    where: { id: `${PREFIX}-zone` },
    update: {},
    create: {
      id: `${PREFIX}-zone`,
      code: 'DSF',
      name: 'Driver Surface Zone',
      city: 'Bengaluru',
      centroidLat: 12.9352,
      centroidLng: 77.6245,
    },
  });
  await prismaBase.vehicleProfile.upsert({
    where: { id: `${PREFIX}-profile` },
    update: {},
    create: {
      id: `${PREFIX}-profile`,
      make: 'Tata',
      model: 'Tiago',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
  });

  for (const who of ['driver', 'other-driver']) {
    await prismaBase.user.upsert({
      where: { id: `${PREFIX}-${who}-user` },
      update: {},
      create: {
        id: `${PREFIX}-${who}-user`,
        email: `${PREFIX}-${who}@example.test`,
        passwordHash: 'not-used',
        role: 'DRIVER',
        name: 'Fixture Driver',
      },
    });
    await prismaBase.driver.upsert({
      where: { id: `${PREFIX}-${who === 'driver' ? 'driver' : 'other-driver'}` },
      update: {},
      create: {
        id: `${PREFIX}-${who === 'driver' ? 'driver' : 'other-driver'}`,
        userId: `${PREFIX}-${who}-user`,
        tenantId: TENANT,
      },
    });
  }

  await prismaBase.vehicle.upsert({
    where: { id: `${PREFIX}-vehicle` },
    update: {},
    create: {
      id: `${PREFIX}-vehicle`,
      driverId: `${PREFIX}-driver`,
      tenantId: TENANT,
      profileId: `${PREFIX}-profile`,
      registration: 'KA01DS0001',
      colour: 'White',
    },
  });

  // "Ravi" rather than "Technician 07" so the sentence in the response reads
  // like the brief's example. The route shows the first name only.
  await prismaBase.user.upsert({
    where: { id: `${PREFIX}-tech-user` },
    update: {},
    create: {
      id: `${PREFIX}-tech-user`,
      email: `${PREFIX}-tech@example.test`,
      passwordHash: 'not-used',
      role: 'TECHNICIAN',
      name: 'Ravi Kumar',
    },
  });
  await prismaBase.technician.upsert({
    where: { id: `${PREFIX}-tech` },
    update: {},
    create: {
      id: `${PREFIX}-tech`,
      userId: `${PREFIX}-tech-user`,
      employeeCode: `${PREFIX}-T1`,
      homeZoneId: `${PREFIX}-zone`,
    },
  });
  await prismaBase.unit.upsert({
    where: { id: `${PREFIX}-unit` },
    update: {},
    create: {
      id: `${PREFIX}-unit`,
      code: 'DSF-VAN-1',
      kind: 'VAN',
      zoneId: `${PREFIX}-zone`,
      status: 'ON_JOB',
      lat: 12.94,
      lng: 77.62,
    },
  });

  const job = await prismaBase.job.upsert({
    where: { id: `${PREFIX}-job` },
    update: { status: 'ON_SITE' },
    create: {
      id: `${PREFIX}-job`,
      tenantId: TENANT,
      driverId: `${PREFIX}-driver`,
      vehicleId: `${PREFIX}-vehicle`,
      zoneId: `${PREFIX}-zone`,
      status: 'ON_SITE',
      safetyLevel: 'ELEVATED',
      assignedUnitId: `${PREFIX}-unit`,
      assignedTechnicianId: `${PREFIX}-tech`,
      lat: 12.9352,
      lng: 77.6245,
      roadPosition: 'SHOULDER',
    },
    select: { id: true },
  });

  // Events are append-only, so the fixture writes them once and later runs
  // reuse them — a second insert would collide on (job, sequence).
  const existingEvents = await prismaBase.jobEvent.count({ where: { jobId: job.id } });
  if (existingEvents === 0) {
    const types = ['JOB_CREATED', 'SAFETY_TRIAGED', 'DISPATCH_COMMITTED', 'TECHNICIAN_ARRIVED'];
    for (const [index, eventType] of types.entries()) {
      await prismaBase.jobEvent.create({
        data: { jobId: job.id, sequence: index + 1, eventType, payload: {} },
      });
    }
  }

  await prismaBase.faultHypothesis.upsert({
    where: { id: `${PREFIX}-hypothesis` },
    update: {},
    create: {
      id: `${PREFIX}-hypothesis`,
      jobId: job.id,
      distribution: {
        FLAT_BATTERY: 0.45,
        ALTERNATOR_FAILURE: 0.4,
        FAILED_BATTERY: 0.05,
        STARTER_MOTOR: 0.03,
        OUT_OF_FUEL: 0.02,
        FLAT_TYRE: 0.01,
        KEYS_LOCKED_IN: 0.01,
        KEY_FAILURE: 0.01,
        ENGINE_OVERHEAT: 0.01,
        BRAKE_FAILURE: 0.005,
        EV_HV_FAULT: 0.005,
        IMMOBILISED_UNKNOWN: 0.0,
      },
      requiredCapabilityCodes: ['JUMP_START', 'ALTERNATOR_REPLACEMENT'],
      entropy: 1.2,
      topFault: 'FLAT_BATTERY',
    },
  });

  await prismaBase.etaEstimate.upsert({
    where: { id: `${PREFIX}-eta` },
    update: {},
    create: { id: `${PREFIX}-eta`, jobId: job.id, unitId: `${PREFIX}-unit`, etaSeconds: 900, method: 'OSRM' },
  });

  await prismaBase.completionVerification.upsert({
    where: { jobId: job.id },
    update: { code: '482913', verifiedAt: null },
    create: { jobId: job.id, code: '482913' },
  });

  // Written by hand: generating an estimate is the money domain's job (Phase
  // 15c) and nothing writes one yet. The READ path is Phase 15's promise —
  // cost on screen before the code that confirms the work — so it is proved
  // here rather than left to be discovered missing later.
  await prismaBase.estimate.upsert({
    where: { id: `${PREFIX}-estimate` },
    update: {},
    create: {
      id: `${PREFIX}-estimate`,
      jobId: job.id,
      status: 'SENT',
      subtotalPaise: 144000,
      totalPaise: 144000,
      lines: {
        create: [
          { kind: 'PART', description: 'Drive belt', quantity: 1, unitPricePaise: 64000, amountPaise: 64000 },
          { kind: 'LABOUR', description: 'Labour, one hour', quantity: 1, unitPricePaise: 80000, amountPaise: 80000 },
        ],
      },
    },
  });

  return job.id;
}
