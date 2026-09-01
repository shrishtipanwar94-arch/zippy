// ASSEMBLING THE FLEET DASHBOARD — the one function src/api/fleet.ts calls.
//
// Reads once (fleetIncidentsFor), then hands the same plain array to every
// pure calculator that needs it: the four numbers in src/domain/fleetMetrics.ts,
// and the per-vehicle repeat-pattern rule in src/domain/repeatPattern.ts. No
// second query, no number computed a different way than another number that
// should agree with it.
//
// NO CROSS-TENANT VISIBILITY. There is exactly one tenant id in this whole
// file, taken from the caller — src/commit/fleetIncidents.ts's own comment
// explains why that filter is explicit rather than left to the auth-context
// extension.

import type { PrismaClient } from '@prisma/client';
import { fleetIncidentsFor, isActiveIncident } from './fleetIncidents.js';
import type { FleetIncident } from './fleetIncidents.js';
import {
  currentExposurePaise,
  meanResolutionSummary,
  slaMetSummary,
  slaOutcomeFor,
  spendPaiseThisMonth,
} from '../domain/fleetMetrics.js';
import { repeatPatternFlag } from '../domain/repeatPattern.js';
import type { RepeatPatternFlag } from '../domain/repeatPattern.js';

export type ActiveIncidentView = {
  jobId: string;
  vehicleId: string;
  registration: string;
  status: string;
  safetyLevel: string;
  createdAt: string;
  topFault: string | null;
};

export type VehicleIncidentRow = {
  jobId: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  topFault: string | null;
  // MET / BREACHED / UNDECIDED / NOT_APPLICABLE — carried per row so the
  // per-vehicle history can show which incidents were on-time without the
  // browser re-deriving the same deadline arithmetic this file already did.
  slaOutcome: string;
};

export type VehicleHistoryView = {
  vehicleId: string;
  registration: string;
  make: string;
  model: string;
  incidents: VehicleIncidentRow[];
  // Null when nothing has recurred. LABELLED A RULE ON THE CARD ITSELF
  // (public/js/pages/fleet.js), not only in this comment — the phase brief is
  // explicit that a reader must never mistake this for a prediction.
  repeatPatternFlag: RepeatPatternFlag | null;
};

export type FleetDashboard = {
  tenantId: string;
  generatedAt: string;
  activeIncidents: ActiveIncidentView[];
  slaMetPercent: number | null;
  slaDecidedCount: number;
  currentExposurePaise: number;
  meanResolutionMinutes: number | null;
  resolvedCount: number;
  spendPaise: number;
  vehicles: VehicleHistoryView[];
};

export async function buildFleetDashboard(
  db: PrismaClient,
  tenantId: string,
  now: Date = new Date(),
): Promise<FleetDashboard> {
  const incidents = await fleetIncidentsFor(db, tenantId);

  const sla = slaMetSummary(incidents, now);
  const resolution = meanResolutionSummary(incidents, now);

  return {
    tenantId,
    generatedAt: now.toISOString(),
    activeIncidents: incidents
      .filter((incident) => isActiveIncident(incident.status))
      // Newest first — the same ordering every other queue and timeline in
      // this codebase uses, so a fleet manager reads it the way they read
      // everything else.
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(toActiveIncidentView),
    slaMetPercent: sla.metPercent,
    slaDecidedCount: sla.decidedCount,
    currentExposurePaise: currentExposurePaise(incidents, now),
    meanResolutionMinutes: resolution.meanMinutes,
    resolvedCount: resolution.resolvedCount,
    spendPaise: spendPaiseThisMonth(incidents, now),
    vehicles: groupByVehicle(incidents, now),
  };
}

function toActiveIncidentView(incident: FleetIncident): ActiveIncidentView {
  return {
    jobId: incident.jobId,
    vehicleId: incident.vehicleId,
    registration: incident.registration,
    status: incident.status,
    safetyLevel: incident.safetyLevel,
    createdAt: incident.createdAt.toISOString(),
    topFault: incident.topFault,
  };
}

// PER-VEHICLE INCIDENT HISTORY, and the repeat-pattern flag on top of it.
// Grouped here rather than in a query because the grouping key is a business
// concept (one vehicle's whole record), not a `GROUP BY` — a fleet manager
// wants the LIST of what happened, and the flag is a rule computed over that
// same list, not a separate fact.
function groupByVehicle(incidents: FleetIncident[], now: Date): VehicleHistoryView[] {
  const byVehicle = new Map<string, FleetIncident[]>();
  for (const incident of incidents) {
    const bucket = byVehicle.get(incident.vehicleId);
    if (bucket) bucket.push(incident);
    else byVehicle.set(incident.vehicleId, [incident]);
  }

  const vehicles: VehicleHistoryView[] = [];
  for (const [vehicleId, vehicleIncidents] of byVehicle) {
    const sorted = [...vehicleIncidents].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const first = sorted[0]!;

    vehicles.push({
      vehicleId,
      registration: first.registration,
      make: first.make,
      model: first.model,
      incidents: sorted.map((incident) => ({
        jobId: incident.jobId,
        status: incident.status,
        createdAt: incident.createdAt.toISOString(),
        resolvedAt: incident.resolvedAt ? incident.resolvedAt.toISOString() : null,
        topFault: incident.topFault,
        slaOutcome: slaOutcomeFor({
          createdAt: incident.createdAt,
          responseMinutes: incident.responseMinutes,
          arrivedAt: incident.arrivedAt,
          now,
        }),
      })),
      repeatPatternFlag: repeatPatternFlag(
        vehicleIncidents
          .filter((incident): incident is FleetIncident & { topFault: NonNullable<FleetIncident['topFault']> } =>
            incident.topFault !== null,
          )
          .map((incident) => ({ fault: incident.topFault, at: incident.createdAt })),
        now,
      ),
    });
  }

  // Worst-served vehicle first: a flag beats no flag, and within the same
  // flag state the vehicle with the most recent incident is the one worth
  // opening. A fleet manager scanning a list should see trouble before they
  // see quiet.
  vehicles.sort((a, b) => {
    const flagged = Number(b.repeatPatternFlag !== null) - Number(a.repeatPatternFlag !== null);
    if (flagged !== 0) return flagged;
    return (b.incidents[0]?.createdAt ?? '').localeCompare(a.incidents[0]?.createdAt ?? '');
  });

  return vehicles;
}
