// READING ONE TENANT'S INCIDENT HISTORY — the one query the fleet dashboard's
// numbers are all computed from.
//
// EVERY OTHER FLEET DASHBOARD FUNCTION IS PURE AND TAKES THIS FILE'S OUTPUT.
// `src/domain/fleetMetrics.ts` computes SLA%, exposure and mean resolution
// time from a plain array of `FleetIncident`; `src/domain/repeatPattern.ts`
// takes one vehicle's faults and dates. Neither knows Prisma exists. That
// split is what makes "does the SLA percentage handle an UNDECIDED job
// correctly" a question a test can ask without a database.
//
// TENANT-SCOPED BY AN EXPLICIT FILTER, not by the auth-context Prisma
// extension. This file is called from a FLEET_MANAGER-only route
// (src/api/fleet.ts) with the tenant id taken from the CALLER'S OWN TOKEN, and
// keeping the filter explicit here — the same choice src/commit/dispatchSnapshot.ts
// makes for the opposite reason — is what lets this be tested directly against
// `prismaBase` without standing up an AsyncLocalStorage auth context first.

import type { JobStatus, PrismaClient, SafetyLevel } from '@prisma/client';
import { isFaultCode } from '../domain/faults.js';
import type { FaultCode } from '../domain/faults.js';

// Mirrors src/commit/dispatchSnapshot.ts's own list. Each file defines its own
// copy rather than importing the other's local constant — the same "engine
// files define their own vocabulary" rule applied one layer up, because a
// shared constant would couple two files that otherwise have nothing to do
// with each other.
const TERMINAL_JOB_STATUSES = ['RESOLVED', 'UNSERVICEABLE', 'CANCELLED'] as const;

export type FleetIncident = {
  jobId: string;
  vehicleId: string;
  registration: string;
  make: string;
  model: string;
  status: JobStatus;
  safetyLevel: SafetyLevel;
  createdAt: Date;
  resolvedAt: Date | null;
  // The last belief this job settled on. Null for a job that never reached a
  // hypothesis at all (should not happen for a real job, but a dashboard reads
  // the database as it is, not as it should be).
  topFault: FaultCode | null;
  // Null when this job carries no contract response window.
  responseMinutes: number | null;
  breachPenaltyPaise: number;
  // The TECHNICIAN_ARRIVED event's timestamp, if the job ever reached one.
  arrivedAt: Date | null;
  // What the work was worth — src/commit/estimates.ts's own words for this
  // number (`approvedTotalFor`). Null when nothing was ever approved on this
  // job, which is different from zero and the honest answer for most jobs
  // still in progress.
  approvedTotalPaise: number | null;
};

export async function fleetIncidentsFor(
  db: PrismaClient,
  tenantId: string,
): Promise<FleetIncident[]> {
  const jobs = await db.job.findMany({
    where: { tenantId },
    select: {
      id: true,
      vehicleId: true,
      status: true,
      safetyLevel: true,
      createdAt: true,
      resolvedAt: true,
      vehicle: {
        select: { registration: true, profile: { select: { make: true, model: true } } },
      },
      slaPolicy: { select: { responseMinutes: true, breachPenaltyPaise: true } },
      faultHypotheses: {
        orderBy: { version: 'desc' },
        take: 1,
        select: { topFault: true },
      },
      // The same tie-break src/commit/estimates.ts's `approvedEstimateFor`
      // uses, so a job with (in principle) more than one APPROVED row is read
      // identically here and there.
      estimates: {
        where: { status: 'APPROVED' },
        orderBy: { totalPaise: 'desc' },
        take: 1,
        select: { totalPaise: true },
      },
    },
  });

  if (jobs.length === 0) return [];

  // ONE QUERY FOR EVERY JOB'S ARRIVAL, not one per job. `TECHNICIAN_ARRIVED`
  // is written once per job (the ladder is monotonic — src/domain/jobLadder.ts
  // — so a replay cannot produce a second one), which is what makes "the
  // first row per job" safe to take without an ORDER BY doing real work.
  const arrivals = await db.jobEvent.findMany({
    where: { jobId: { in: jobs.map((job) => job.id) }, eventType: 'TECHNICIAN_ARRIVED' },
    select: { jobId: true, at: true },
  });
  const arrivedAtByJob = new Map(arrivals.map((event) => [event.jobId, event.at]));

  return jobs.map((job) => {
    const topFaultRaw = job.faultHypotheses[0]?.topFault ?? null;
    return {
      jobId: job.id,
      vehicleId: job.vehicleId,
      registration: job.vehicle.registration,
      make: job.vehicle.profile.make,
      model: job.vehicle.profile.model,
      status: job.status,
      safetyLevel: job.safetyLevel,
      createdAt: job.createdAt,
      resolvedAt: job.resolvedAt,
      topFault: topFaultRaw && isFaultCode(topFaultRaw) ? topFaultRaw : null,
      responseMinutes: job.slaPolicy?.responseMinutes ?? null,
      breachPenaltyPaise: job.slaPolicy?.breachPenaltyPaise ?? 0,
      arrivedAt: arrivedAtByJob.get(job.id) ?? null,
      approvedTotalPaise: job.estimates[0]?.totalPaise ?? null,
    };
  });
}

export function isActiveIncident(status: JobStatus): boolean {
  return !(TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}
