// INTAKE — a breakdown report becomes a job.
//
// Four things happen here and all four are inputs to a dispatch decision that
// has not been made yet: the symptoms become a probability distribution over
// faults, the situation becomes a safety level, the position becomes a
// location a unit can actually be routed to, and the whole thing becomes a
// job row with an event trail.
//
// THE DISTRIBUTION IS STILL THE RULE TABLE'S, and always will be. Phase 16
// added a model at the edge, and all it does is fill in the symptom payload
// this function is handed — which the driver confirms first. By the time
// execution reaches here there is no difference between a job described in
// Hindi to a model and a job tapped into the picker, except one column on the
// symptom report saying which happened.
//
// Everything is written in one transaction: a job whose symptom report or
// first hypothesis is missing is not a partially-created job, it is a job the
// question selector would crash on.

import type { Prisma, PrismaClient, SafetyLevel, SettlementPath } from '@prisma/client';
import { classifySymptoms } from '../domain/faultRules.js';
import type { SymptomPayload } from '../domain/symptoms.js';
import { buildSafetyContext, triageSafety } from '../domain/safety.js';
import type { SafetyReport } from '../domain/safety.js';
import { locationColumns } from '../domain/location.js';
import type { LocationInput } from '../domain/location.js';
import { nearestZone } from '../domain/geo.js';
import { priceListInForce } from '../pricing/priceList.js';
import { settlementPathFor } from '../commit/settlement.js';
import { slaPolicyIdInForce } from '../commit/contractTerms.js';
import { fleetVehiclePriorFaults } from '../commit/fleetPrior.js';
import { fleetVehiclePrior } from '../domain/fleetPrior.js';
import { FAULT_PRIORS } from '../domain/faults.js';
import { logger } from '../infra/logger.js';
import { linkExtractionToJob } from '../ai/store.js';
import { appendJobEvent } from './events.js';
import { recordHypothesis } from './hypothesis.js';
import { runIntakeTransaction } from './transaction.js';
import { nextQuestionView } from './session.js';
import type { NextQuestionView } from './session.js';
import { IntakeError } from './errors.js';

export type IntakeActor = { role: string; id: string } | null;

export type IntakeRequest = {
  driverId: string;
  vehicleId: string;
  tenantId: string | null;
  symptoms: SymptomPayload;
  // What the caller stated. Whether the vehicle is on a highway is NOT in here
  // — it is derived below from the reported road position.
  safety: SafetyReport;
  location: LocationInput;
  // Present from Phase 16, when the driver describes the fault in their own
  // words and an LLM fills in `symptoms`. Stored verbatim so the extraction can
  // be audited against what was actually said.
  rawText?: string | null;
  // The AiExtraction this job is the driver's answer to, when they came in
  // through /jobs/intake/describe. Linking it here — inside the same
  // transaction that creates the job — is what makes "the driver confirmed
  // what the model read" a fact in the database rather than an inference from
  // two timestamps.
  extractionId?: string | null;
  actor: IntakeActor;
  // The simulator passes simulated time so a seeded replay produces the same
  // night/day triage every run. The API passes the real clock.
  at: Date;
};

export type IntakeResult = {
  jobId: string;
  zoneId: string;
  // The prices this job will settle at, whatever happens to the catalogue
  // afterwards. Null when no list was in force — see resolvePriceListId.
  priceListId: string | null;
  // WHICH OF THE THREE WAYS this job settles, resolved from the driver's
  // contract at this instant and never asked again. A contract that lapses
  // while a technician is driving out does not retroactively hand the customer
  // a bill they were never quoted.
  settlementPath: SettlementPath;
  // The SLA policy this job is pinned to, or null for a walk-in. Returned
  // alongside the other two pinned decisions so a caller can see all three
  // without a second read.
  slaPolicyId: string | null;
  safetyLevel: SafetyLevel;
  safetyReasonCodes: string[];
  entropyBits: number;
  topFault: string;
  requiredCapabilityCodes: string[];
  next: NextQuestionView;
};

async function resolveZoneId(tx: Prisma.TransactionClient, lat: number, lng: number): Promise<string> {
  const zones = await tx.zone.findMany({ select: { id: true, centroidLat: true, centroidLng: true } });
  const zone = nearestZone(zones, lat, lng);
  if (!zone) {
    throw new IntakeError('NO_ZONE_CONFIGURED', 'no zones are configured; run the seed');
  }
  return zone.id;
}

// THE PRICES THIS JOB WILL SETTLE AT, decided here and never again.
//
// A job prices against the list in force AT CREATION and is never re-priced,
// because the customer agreed to one set of numbers (src/pricing/priceList.ts
// has the full argument). Pinning the id on the row is what makes that true
// rather than aspirational: every later question reads this column instead of
// asking the clock.
//
// A MISSING LIST DOES NOT FAIL INTAKE. If no list is in force — one lapsed and
// its successor was never activated — the column stays null and the job is
// created anyway. This is the same rule the money domain applies throughout:
// payment is never on the dispatch critical path, and a stranded driver does
// not wait for a catalogue. It is a degraded state, so it is logged rather
// than swallowed (invariant 8), and the estimate builder has to handle a job
// it cannot price.
async function resolvePriceListId(
  tx: Prisma.TransactionClient,
  request: IntakeRequest,
): Promise<string | null> {
  const priceListId = await priceListInForce(tx, {
    tenantId: request.tenantId,
    at: request.at,
  });
  if (!priceListId) {
    logger.warn(
      { tenantId: request.tenantId, at: request.at },
      'no price list in force at job creation; this job will have no pinned prices',
    );
  }
  return priceListId;
}

export async function createIntakeJob(db: PrismaClient, request: IntakeRequest): Promise<IntakeResult> {
  const columns = locationColumns(request.location);

  // ONE FACT, ONE HOME. The road position the driver reported is the only
  // input; `isOnHighway` turns it into the job's `on_highway` column and, via
  // buildSafetyContext, into what triage reasons over. A client cannot supply
  // the two inconsistently because it cannot supply either.
  const safetyContext = buildSafetyContext(request.safety, {
    roadPosition: columns.roadPosition,
    at: request.at,
  });
  const triage = triageSafety(safetyContext);

  return runIntakeTransaction(db, async (tx) => {
    const zoneId = await resolveZoneId(tx, columns.lat, columns.lng);
    const priceListId = await resolvePriceListId(tx, request);
    // Pinned for the same reason the price list is. Unlike the price list this
    // has no null case: every job settles SOME way, and a job with no contract
    // is a walk-in rather than an unanswerable question.
    const settlementPath = await settlementPathFor(tx, {
      tenantId: request.tenantId,
      onHighway: columns.onHighway,
      at: request.at,
    });
    // The third pinning, and the one dispatch reads: the response window this
    // job is promised and what breaching it costs. Null for a walk-in.
    const slaPolicyId = await slaPolicyIdInForce(tx, {
      tenantId: request.tenantId,
      onHighway: columns.onHighway,
      at: request.at,
    });

    // THE INTAKE PRIOR (Phase 21). A fleet vehicle's own past incidents,
    // folded in as the starting belief before this job's actual symptoms are
    // read — see src/domain/fleetPrior.ts for why this is a rule and not a
    // model. Empty for everyone else, which is what makes `fleetVehiclePrior`
    // a no-op and `distribution` come out identical to Phase 3's behaviour.
    const priorFaults = await fleetVehiclePriorFaults(tx, {
      vehicleId: request.vehicleId,
      tenantId: request.tenantId,
      before: request.at,
    });
    const startingPrior = fleetVehiclePrior(FAULT_PRIORS, priorFaults);
    const distribution = classifySymptoms(request.symptoms, startingPrior);

    const job = await tx.job.create({
      data: {
        tenantId: request.tenantId,
        driverId: request.driverId,
        vehicleId: request.vehicleId,
        zoneId,
        priceListId,
        settlementPath,
        slaPolicyId,
        status: 'INTAKE',
        safetyLevel: triage.level,
        createdAt: request.at,
        ...columns,
      },
      select: { id: true },
    });

    await tx.symptomReport.create({
      data: {
        jobId: job.id,
        // WHERE THE PAYLOAD CAME FROM, which is the only trace of the AI in
        // this table: an AI_ASSISTED report is one the driver confirmed after
        // a model filled it in, and its fields are otherwise identical to a
        // STRUCTURED one. Nothing downstream reads this column — it is there
        // so that a question about a job's diagnosis can be answered.
        source: request.extractionId ? 'AI_ASSISTED' : 'STRUCTURED',
        payload: request.symptoms,
        rawText: request.rawText ?? null,
      },
    });

    if (request.extractionId) {
      await linkExtractionToJob(tx, {
        extractionId: request.extractionId,
        jobId: job.id,
        symptoms: request.symptoms,
      });
    }

    // The position as reported, kept as its own event as well as job columns:
    // the columns are "where it is now", this is "what we were told, when".
    await tx.locationEvent.create({
      data: {
        jobId: job.id,
        lat: columns.lat,
        lng: columns.lng,
        headingDegrees: columns.headingDegrees,
        // How much to trust the two numbers above. See domain/location.ts.
        accuracyMetres: request.location.accuracyMetres,
        source: 'INTAKE',
        eventTime: request.at,
      },
    });

    const hypothesis = await recordHypothesis(tx, job.id, distribution);

    const actorRole = request.actor?.role ?? null;
    const actorId = request.actor?.id ?? null;
    const common = { jobId: job.id, actorRole, actorId, at: request.at };

    await appendJobEvent(tx, {
      ...common,
      eventType: 'JOB_CREATED',
      // The pinned price list is on the event as well as the column: the
      // column is what the job settles at, this is the record that it was
      // decided at creation and by whom.
      payload: { zoneId, priceListId, settlementPath, slaPolicyId },
    });
    await appendJobEvent(tx, {
      ...common,
      eventType: 'SYMPTOMS_CAPTURED',
      payload: {
        primaryComplaint: request.symptoms.primaryComplaint,
        source: request.extractionId ? 'AI_ASSISTED' : 'STRUCTURED',
      },
    });
    await appendJobEvent(tx, {
      ...common,
      eventType: 'SAFETY_TRIAGED',
      payload: { level: triage.level, reasonCodes: triage.reasonCodes },
    });
    await appendJobEvent(tx, {
      ...common,
      eventType: 'LOCATION_CAPTURED',
      payload: {
        roadPosition: columns.roadPosition,
        carriagewayDirection: columns.carriagewayDirection,
        onHighway: columns.onHighway,
      },
    });
    await appendJobEvent(tx, {
      ...common,
      eventType: 'FAULT_HYPOTHESIS_UPDATED',
      payload: {
        version: hypothesis.version,
        entropyBits: hypothesis.entropy,
        topFault: hypothesis.topFault,
        requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
      },
    });

    // Built from what was just computed rather than read back: the row we would
    // re-read is the row we just wrote, and a round trip inside a transaction is
    // not free.
    const next = nextQuestionView({ jobId: job.id, hypothesis, askedCodes: [] });

    // "Flat tyre" lands here: the first hypothesis is already certain enough,
    // so intake completes without asking anything at all.
    if (next.done) {
      await appendJobEvent(tx, {
        ...common,
        eventType: 'INTAKE_COMPLETED',
        payload: {
          reason: next.reason,
          questionsAsked: 0,
          entropyBits: hypothesis.entropy,
          requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
        },
      });
    }

    return {
      jobId: job.id,
      zoneId,
      priceListId,
      settlementPath,
      slaPolicyId,
      safetyLevel: triage.level,
      safetyReasonCodes: triage.reasonCodes,
      entropyBits: hypothesis.entropy,
      topFault: hypothesis.topFault,
      requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
      next,
    };
  });
}
