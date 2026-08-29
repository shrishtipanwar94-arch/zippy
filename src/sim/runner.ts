// THE SIMULATOR LOOP — invents breakdowns and walks each one through the real
// intake pipeline.
//
// It calls createIntakeJob() and recordIntakeAnswer(), the same functions the
// HTTP routes call. Nothing here reimplements intake, because the whole value
// of the simulator is that what it exercises is production code: Phase 10's
// evaluation harness replays scenarios through this and compares policies, and
// a parallel copy of the pipeline would make every measured number a lie.
//
// It writes through `prismaBase`, the UNSCOPED client, because it runs outside
// any request and therefore has no auth context. The tenant-scope extension
// treats "no context" as "no tenant" and would return nothing for every read —
// correctly, that is what fails closed means. The simulator supplies each job's
// tenant explicitly, from the driver it picked.

import type { PrismaClient } from '@prisma/client';
import { createRandom } from './random.js';
import { createIntakeJob } from '../intake/createJob.js';
import { recordIntakeAnswer } from '../intake/answers.js';
import { findQuestion } from '../domain/questions.js';
import { generateLocation, generateSafetyContext, generateSymptoms, arrivalOffsetsSeconds } from './scenarios.js';
import { answerAsDriver } from './driverAnswers.js';
import type { SimulatorConfig, Situation } from './config.js';
import type { SimulatedJob } from './outcomes.js';
import type { FaultCode } from '../domain/faults.js';

// Simulated seconds a driver takes to read and answer one question. Fixed, not
// random: it only shifts timestamps, and keeping it constant makes an event
// trail easier to read.
const SECONDS_PER_ANSWER = 20;

type RosterEntry = { driverId: string; vehicleId: string; tenantId: string | null; lat: number; lng: number };

// Ordered by id so the same seed picks the same drivers on every machine.
async function loadRoster(db: PrismaClient): Promise<RosterEntry[]> {
  const drivers = await db.driver.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      tenantId: true,
      homeZone: { select: { centroidLat: true, centroidLng: true } },
      vehicles: { orderBy: { id: 'asc' }, take: 1, select: { id: true } },
    },
  });

  const roster: RosterEntry[] = [];
  for (const driver of drivers) {
    const vehicle = driver.vehicles[0];
    if (!vehicle || !driver.homeZone) continue;
    roster.push({
      driverId: driver.id,
      vehicleId: vehicle.id,
      tenantId: driver.tenantId,
      lat: driver.homeZone.centroidLat,
      lng: driver.homeZone.centroidLng,
    });
  }
  return roster;
}

export type SimulationHooks = {
  onJob?: (job: SimulatedJob) => void;
  // Checked before every arrival. Returning true ends the run cleanly — this is
  // the kill switch the long-lived worker uses.
  shouldStop?: () => Promise<boolean> | boolean;
  // Called with the real milliseconds to wait before the next arrival. The
  // one-shot runner ignores it; the live worker sleeps.
  waitMs?: (milliseconds: number) => Promise<void>;
};

async function runOneJob(
  db: PrismaClient,
  config: SimulatorConfig,
  random: ReturnType<typeof createRandom>,
  roster: RosterEntry[],
  index: number,
  offsetSeconds: number,
  startAt: Date,
): Promise<SimulatedJob> {
  const trueFault = random.pickWeighted(config.faultMix) as FaultCode;
  const situation = random.pickWeighted(config.situationMix) as Situation;
  const driver = roster[random.nextInt(roster.length)]!;

  const symptoms = generateSymptoms(random, trueFault);
  const safety = generateSafetyContext(random, situation, trueFault);
  const location = generateLocation(random, situation, { lat: driver.lat, lng: driver.lng });
  const arrivalAt = new Date(startAt.getTime() + offsetSeconds * 1000);

  const created = await createIntakeJob(db, {
    driverId: driver.driverId,
    vehicleId: driver.vehicleId,
    tenantId: driver.tenantId,
    symptoms,
    safety,
    location,
    actor: { role: 'SIMULATOR', id: `sim-${config.seed}` },
    at: arrivalAt,
  });

  const entropyStartBits = created.entropyBits;
  let next = created.next;
  let questionsAsked = 0;
  let entropyEndBits = created.entropyBits;
  let topFault = created.topFault;
  let requiredCapabilityCodes = created.requiredCapabilityCodes;

  while (!next.done) {
    const question = findQuestion(next.question.code);
    if (!question) break;

    const answer = answerAsDriver(random, question, trueFault);
    questionsAsked += 1;
    const answeredAt = new Date(arrivalAt.getTime() + questionsAsked * SECONDS_PER_ANSWER * 1000);

    const result = await recordIntakeAnswer(db, {
      jobId: created.jobId,
      questionCode: question.code,
      answer,
      actor: { role: 'SIMULATOR', id: `sim-${config.seed}` },
      at: answeredAt,
    });

    entropyEndBits = result.entropyAfterBits;
    topFault = result.topFault;
    requiredCapabilityCodes = result.requiredCapabilityCodes;
    next = result.next;
  }

  return {
    index,
    arrivalOffsetSeconds: offsetSeconds,
    trueFault,
    primaryComplaint: symptoms.primaryComplaint,
    situation,
    safetyLevel: created.safetyLevel,
    safetyReasonCodes: created.safetyReasonCodes,
    questionsAsked,
    entropyStartBits,
    entropyEndBits,
    stopReason: next.done ? next.reason : 'ABANDONED',
    topFault,
    requiredCapabilityCodes,
  };
}

export async function runSimulation(
  db: PrismaClient,
  config: SimulatorConfig,
  hooks: SimulationHooks = {},
): Promise<SimulatedJob[]> {
  const roster = await loadRoster(db);
  if (roster.length === 0) {
    throw new Error('no drivers with a vehicle and a home zone; run `npm run db:seed` first');
  }

  // One generator for the whole run. The schedule is drawn first so it is fixed
  // by the seed regardless of how long the database takes.
  const random = createRandom(config.seed);
  const offsets = arrivalOffsetsSeconds(random, config);
  const startAt = config.startAtIso ? new Date(config.startAtIso) : new Date();

  const jobs: SimulatedJob[] = [];
  let previousOffset = 0;

  for (let index = 0; index < offsets.length; index += 1) {
    if (hooks.shouldStop && (await hooks.shouldStop())) break;

    const offsetSeconds = offsets[index]!;
    if (hooks.waitMs && config.realSecondsPerSimulatedMinute > 0) {
      const simulatedGapMinutes = (offsetSeconds - previousOffset) / 60;
      await hooks.waitMs(simulatedGapMinutes * config.realSecondsPerSimulatedMinute * 1000);
    }
    previousOffset = offsetSeconds;

    const job = await runOneJob(db, config, random, roster, index + 1, offsetSeconds, startAt);
    jobs.push(job);
    hooks.onJob?.(job);
  }

  return jobs;
}
