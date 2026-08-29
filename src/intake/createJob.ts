// INTAKE — a breakdown report becomes a job.
//
// Four things happen here and all four are inputs to a dispatch decision that
// has not been made yet: the symptoms become a probability distribution over
// faults, the situation becomes a safety level, the position becomes a
// location a unit can actually be routed to, and the whole thing becomes a
// job row with an event trail.
//
// There is no AI in this path (Phase 3 has none anywhere). The distribution
// comes from a hand-written rule table. Phase 16 replaces only the INPUT to
// that table — free text through an LLM extractor — never this structure.
//
// Everything is written in one transaction: a job whose symptom report or
// first hypothesis is missing is not a partially-created job, it is a job the
// question selector would crash on.

import type { Prisma, PrismaClient, SafetyLevel } from '@prisma/client';
import { classifySymptoms } from '../domain/faultRules.js';
import type { SymptomPayload } from '../domain/symptoms.js';
import { buildSafetyContext, triageSafety } from '../domain/safety.js';
import type { SafetyReport } from '../domain/safety.js';
import { locationColumns } from '../domain/location.js';
import type { LocationInput } from '../domain/location.js';
import { nearestZone } from '../domain/geo.js';
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
  actor: IntakeActor;
  // The simulator passes simulated time so a seeded replay produces the same
  // night/day triage every run. The API passes the real clock.
  at: Date;
};

export type IntakeResult = {
  jobId: string;
  zoneId: string;
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

export async function createIntakeJob(db: PrismaClient, request: IntakeRequest): Promise<IntakeResult> {
  const distribution = classifySymptoms(request.symptoms);
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

    const job = await tx.job.create({
      data: {
        tenantId: request.tenantId,
        driverId: request.driverId,
        vehicleId: request.vehicleId,
        zoneId,
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
        source: 'STRUCTURED',
        payload: request.symptoms,
        rawText: request.rawText ?? null,
      },
    });

    // The position as reported, kept as its own event as well as job columns:
    // the columns are "where it is now", this is "what we were told, when".
    await tx.locationEvent.create({
      data: {
        jobId: job.id,
        lat: columns.lat,
        lng: columns.lng,
        headingDegrees: columns.headingDegrees,
        source: 'INTAKE',
        eventTime: request.at,
      },
    });

    const hypothesis = await recordHypothesis(tx, job.id, distribution);

    const actorRole = request.actor?.role ?? null;
    const actorId = request.actor?.id ?? null;
    const common = { jobId: job.id, actorRole, actorId, at: request.at };

    await appendJobEvent(tx, { ...common, eventType: 'JOB_CREATED', payload: { zoneId } });
    await appendJobEvent(tx, {
      ...common,
      eventType: 'SYMPTOMS_CAPTURED',
      payload: { primaryComplaint: request.symptoms.primaryComplaint },
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
      safetyLevel: triage.level,
      safetyReasonCodes: triage.reasonCodes,
      entropyBits: hypothesis.entropy,
      topFault: hypothesis.topFault,
      requiredCapabilityCodes: hypothesis.requiredCapabilityCodes,
      next,
    };
  });
}
