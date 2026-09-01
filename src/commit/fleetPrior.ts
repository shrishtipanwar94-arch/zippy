// READING A VEHICLE'S OWN HISTORY, for intake to start from.
//
// src/domain/fleetPrior.ts decides what past incidents are WORTH — this
// fetches which faults they were. Same split as everywhere else in this
// codebase: the arithmetic is pure and testable without a database, and this
// file's only job is handing it plain data.
//
// FLEET VEHICLES ONLY. A walk-in consumer's vehicle can have prior jobs too,
// but "known make, model, service history and prior incidents" is what the
// phase brief calls a FLEET vehicle specifically, and `Tenant.kind` is the
// fact that actually distinguishes the two — not merely "this vehicle has a
// tenantId", which a walk-in consumer's vehicle also carries (every tenant,
// consumers included, is a real Tenant row from Phase 2).

import type { Prisma } from '@prisma/client';
import { isFaultCode } from '../domain/faults.js';
import type { FaultCode } from '../domain/faults.js';
import { MAX_PRIOR_INCIDENTS } from '../domain/fleetPrior.js';

// A job that never reached a real diagnosis is not history worth learning
// from. DRAFT never left intake; CANCELLED was withdrawn before anyone looked
// at the vehicle. Everything else — including UNSERVICEABLE — carries a real
// FaultHypothesis and counts.
const NON_INCIDENT_STATUSES = ['DRAFT', 'CANCELLED'] as const;

export type PriorIncidentsQuery = {
  vehicleId: string;
  tenantId: string | null;
  // The instant the NEW job is being created. Only incidents strictly before
  // it count — a job cannot be its own history.
  before: Date;
};

// Most-recent-first, capped at MAX_PRIOR_INCIDENTS — the same cap
// fleetVehiclePrior applies on its own side, so this query never fetches rows
// the arithmetic would throw away anyway.
export async function fleetVehiclePriorFaults(
  tx: Prisma.TransactionClient,
  query: PriorIncidentsQuery,
): Promise<FaultCode[]> {
  if (!query.tenantId) return [];

  const tenant = await tx.tenant.findUnique({
    where: { id: query.tenantId },
    select: { kind: true },
  });
  if (tenant?.kind !== 'FLEET') return [];

  const priorJobs = await tx.job.findMany({
    where: {
      vehicleId: query.vehicleId,
      createdAt: { lt: query.before },
      status: { notIn: [...NON_INCIDENT_STATUSES] },
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_PRIOR_INCIDENTS,
    select: {
      // The LAST belief this job settled on — the most recent hypothesis,
      // whichever path wrote it (intake or an on-site re-diagnosis). There is
      // no separate "confirmed fault" column; this is the same reading
      // src/commit/dispatchSnapshot.ts does for "what do we currently
      // believe about this job".
      faultHypotheses: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { topFault: true },
      },
    },
  });

  const faults: FaultCode[] = [];
  for (const job of priorJobs) {
    const topFault = job.faultHypotheses[0]?.topFault;
    if (topFault && isFaultCode(topFault)) faults.push(topFault);
  }
  return faults;
}
