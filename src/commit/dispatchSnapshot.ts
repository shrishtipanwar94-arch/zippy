// READING THE WORLD INTO THE SHAPE THE SOLVER EXPECTS.
//
// The solver is a pure function over a snapshot and does not know Prisma
// exists (invariant 2). Something still has to go and get the rows, and this
// is it — the one place a `DispatchSnapshot` is built from the database.
//
// IT IS A SNAPSHOT, NOT A LIVE VIEW, and the distinction is the whole point.
// Everything below is read once, into plain objects, and the solver then
// reasons about that frozen picture. The world keeps moving while it does —
// a unit goes offline, a technician's shift ends — and the solver will not
// notice. That is correct and deliberate: a decision made against a
// consistent picture and then validated at commit time (Phase 11's
// version-checked holds) is far easier to reason about than one made against
// state shifting underneath it. The picture being slightly stale is what the
// conditional UPDATE at commit time exists to catch.
//
// Lives in /src/commit rather than /src/engine because it touches the
// database, and the engine's zero-Prisma rule is enforced by a standing grep.

import type { PrismaClient } from '@prisma/client';
import type {
  DispatchSnapshot,
  JobForDispatch,
  SafetyLevelSnapshot,
  UnitKindSnapshot,
  UnitStatusSnapshot,
} from '../engine/candidates.js';
import type { PartsSnapshot } from '../engine/partSourcing.js';
import { FAULT_CODES } from '../domain/faults.js';
import type { FaultDistribution } from '../domain/faults.js';
import { stockConfidence } from '../domain/stockConfidence.js';
import type { ContractTerms, ContractTierSnapshot } from '../domain/contractExposure.js';
import { STOCK_AGE_THRESHOLDS } from './vanStock.js';

// Jobs the solver should be planning for: raised, diagnosed, and not yet
// assigned to anyone.
const PENDING_STATUSES = ['INTAKE', 'PLANNED'] as const;

// A job in one of these is over; re-dispatching it would be dispatching to a
// vehicle that has already been fixed, towed or given up on.
const TERMINAL_JOB_STATUSES = ['RESOLVED', 'UNSERVICEABLE', 'CANCELLED'] as const;

export type SnapshotResult = {
  jobs: JobForDispatch[];
  snapshot: DispatchSnapshot;
  jobZone: Map<string, string>;
};

// A stored fault distribution is JSON. Rebuild it over the known fault codes
// so a missing or extra key cannot reach the maths — the same defensive read
// src/intake/hypothesis.ts does, for the same reason.
function toDistribution(stored: unknown): FaultDistribution {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const distribution = {} as FaultDistribution;
  for (const fault of FAULT_CODES) {
    const value = raw[fault];
    distribution[fault] = typeof value === 'number' && value > 0 ? value : 0;
  }
  return distribution;
}

// The pinned SLA policy as the engine's plain terms. Null when the job pinned
// no policy — a walk-in with no contract behind them, which is most jobs.
function contractTerms(
  policy: { breachPenaltyPaise: number; contract: { tier: { name: string } } } | null,
): ContractTerms | null {
  if (!policy) return null;
  return {
    tier: policy.contract.tier.name as ContractTierSnapshot,
    breachPenaltyPaise: policy.breachPenaltyPaise,
  };
}

export async function buildDispatchSnapshot(
  db: PrismaClient,
  // `zoneId` narrows the JOBS, never the units: a zone's work can legitimately
  // be served by a unit parked next door, and filtering the fleet as well
  // would build the zone-partitioning approximation into the snapshot itself,
  // where the solver could not measure or switch it off.
  //
  // `includeAssigned` is what re-dispatch needs. The default filters to jobs
  // nobody is going to yet, which is right for planning — but a re-dispatch is
  // by definition about a job that ALREADY has a crew, and the whole question
  // is whether that crew should still be the answer. Without this the
  // diagnosis-change flow would ask the solver about a job the solver had
  // already been told to ignore, and get silence back.
  //
  // `now` is the instant the picture is taken, and it exists for exactly one
  // reason: stock confidence is a function of AGE, so "what is believably on
  // this van" cannot be read without saying when. Defaults to the wall clock;
  // a test passes its own so a shelf can be made stale without waiting.
  options: { jobIds?: string[]; zoneId?: string; includeAssigned?: boolean; now?: Date } = {},
): Promise<SnapshotResult> {
  const now = options.now ?? new Date();

  const [jobRows, unitRows, technicianRows, shiftRows, zoneRows, stockRows, priceRows, depotRows] =
    await Promise.all([
    db.job.findMany({
      where: {
        ...(options.includeAssigned
          ? { status: { notIn: [...TERMINAL_JOB_STATUSES] } }
          : { status: { in: [...PENDING_STATUSES] }, assignedUnitId: null }),
        ...(options.jobIds ? { id: { in: options.jobIds } } : {}),
        ...(options.zoneId ? { zoneId: options.zoneId } : {}),
      },
      select: {
        id: true,
        lat: true,
        lng: true,
        zoneId: true,
        createdAt: true,
        safetyLevel: true,
        parkingLevel: true,
        onHighway: true,
        // THE TERMS THIS JOB WAS PINNED TO AT CREATION, followed through the
        // policy it pinned rather than looked up again from the contract that
        // is active now. A contract that lapsed or was re-tiered while a
        // technician was driving out does not change what this job is being
        // served under — the same rule `price_list_id` and `settlement_path`
        // follow, and the reason `slaPolicyId` is a column at all.
        slaPolicy: {
          select: {
            responseMinutes: true,
            breachPenaltyPaise: true,
            contract: { select: { tier: { select: { name: true } } } },
          },
        },
        // The most recent hypothesis is the current belief — intake writes a
        // new row per answer rather than updating in place.
        faultHypotheses: {
          orderBy: { version: 'desc' },
          take: 1,
          select: { distribution: true },
        },
      },
    }),
    db.unit.findMany({
      select: {
        id: true,
        zoneId: true,
        currentTechnicianId: true,
        status: true,
        kind: true,
        lat: true,
        lng: true,
        capabilities: { select: { capability: { select: { code: true } } } },
      },
    }),
    db.technician.findMany({
      where: { active: true },
      select: {
        id: true,
        capabilities: { select: { capability: { select: { code: true } } } },
      },
    }),
    db.technicianShift.findMany({ select: { technicianId: true, startsAt: true, endsAt: true } }),
    db.zone.findMany({ select: { id: true, centroidLat: true, centroidLng: true } }),
    db.unitStock.findMany({
      select: { unitId: true, quantity: true, confirmedAt: true, part: { select: { sku: true } } },
    }),
    // What a part is worth, off the standard list in force right now. NOT the
    // list a job was pinned to at creation — that pinning is a billing
    // guarantee (src/pricing/rateCard.ts) and this is a dispatch input: the
    // solver is asking what a depot run draws out of inventory today, which is
    // one number for the whole fleet rather than one per job.
    db.partPrice.findMany({
      where: {
        priceList: { active: true, tenantId: null },
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      orderBy: { validFrom: 'asc' },
      select: { unitPricePaise: true, part: { select: { sku: true } } },
    }),
    // A depot with no coordinates cannot have a detour measured to it, so it
    // is not a place a crew can be sent — skipped here rather than defended
    // against in the engine.
    db.depot.findMany({
      where: { lat: { not: null }, lng: { not: null } },
      select: { id: true, code: true, lat: true, lng: true },
    }),
  ]);

  const jobZone = new Map<string, string>();
  const jobs: JobForDispatch[] = [];

  for (const row of jobRows) {
    // A job with no location cannot be routed to at all, and a job with no
    // hypothesis has nothing to dispatch against — skipping them here beats
    // letting the engine throw on data intake should never have produced.
    if (row.lat === null || row.lng === null) continue;
    const hypothesis = row.faultHypotheses[0];
    if (!hypothesis) continue;

    jobZone.set(row.id, row.zoneId);
    jobs.push({
      id: row.id,
      lat: row.lat,
      lng: row.lng,
      faultDistribution: toDistribution(hypothesis.distribution),
      createdAt: row.createdAt,
      slaResponseMinutes: row.slaPolicy?.responseMinutes ?? null,
      contract: contractTerms(row.slaPolicy),
      parkingLevel: row.parkingLevel,
      onHighway: row.onHighway ?? false,
      safetyLevel: row.safetyLevel as SafetyLevelSnapshot,
    });
  }

  const snapshot: DispatchSnapshot = {
    units: unitRows.map((unit) => ({
      id: unit.id,
      zoneId: unit.zoneId,
      currentTechnicianId: unit.currentTechnicianId,
      capabilityCodes: unit.capabilities.map((link) => link.capability.code),
      lat: unit.lat,
      lng: unit.lng,
      kind: unit.kind as UnitKindSnapshot,
      status: unit.status as UnitStatusSnapshot,
    })),
    technicians: technicianRows.map((technician) => ({
      id: technician.id,
      capabilityCodes: technician.capabilities.map((link) => link.capability.code),
    })),
    shifts: shiftRows.map((shift) => ({
      technicianId: shift.technicianId,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
    })),
    zones: zoneRows.map((zone) => ({
      id: zone.id,
      centroidLat: zone.centroidLat,
      centroidLng: zone.centroidLng,
    })),
    parts: {
      stock: stockRows.map((row) => ({
        unitId: row.unitId,
        sku: row.part.sku,
        quantity: row.quantity,
        confidence: stockConfidence(row.confirmedAt, now, STOCK_AGE_THRESHOLDS),
      })),
      valuePaiseBySku: Object.fromEntries(
        // Ordered by validFrom ascending above, so a later revision of a price
        // overwrites the earlier one it supersedes.
        priceRows.map((row) => [row.part.sku, row.unitPricePaise]),
      ),
      depots: depotRows.map((depot) => ({
        id: depot.id,
        code: depot.code,
        lat: depot.lat!,
        lng: depot.lng!,
      })),
    } satisfies PartsSnapshot,
  };

  return { jobs, snapshot, jobZone };
}
