// WHAT DEMO MODE HIDES — by filter, never by deleting or rewriting a row.
//
// The live database also holds the full seed: 24 vans, 31 technicians, three
// depots, twelve workshops. The rule for the deployed demo is that nothing in
// it is wiped, so the demo board has to coexist with all of that. Left alone,
// the seeded fleet would compete for every demo job (buildDispatchSnapshot
// reads the whole fleet), the seeded depots would let crew C fetch the part it
// is meant to be missing, and the dispatcher's lists would show jobs and vans
// that are not part of the story.
//
// So with DEMO_MODE on, every read that feeds the solver or the dispatcher's
// screen adds one of the clauses below, and sees only the demo board. With
// DEMO_MODE off each function returns {}, which Prisma treats as "no extra
// condition" — every caller is exactly as it was. Turning the flag off is the
// whole undo. (The flag is a parameter only so a test can ask for demo mode;
// every real caller passes nothing and gets the deployment's setting.)

import type { Prisma } from '@prisma/client';
import { config } from '../infra/config.js';
import { DEMO_CREWS, DEMO_REFERENCE_DRIVER, DEMO_TENANT_ID, DEMO_WORKSHOP } from './demoCrews.js';

// A job in any of these is over. The same three statuses src/api/console.ts
// and src/demo/busyDemoUnits.ts name.
const FINISHED_JOB_STATUSES = ['RESOLVED', 'CANCELLED', 'UNSERVICEABLE'] as const;

// THE JOBS A DEMO DISPATCHER SEES: the demo tenant's jobs that are still live,
// plus the reference job whatever its state (it is finished — see
// prisma/seed/demoReferenceJob.ts). A live job the presenter finished in an
// earlier run drops off the board, so the screen holds two jobs: the one being
// demonstrated, and the reference.
export function demoJobWhere(demoMode: boolean = config.demoMode): Prisma.JobWhereInput {
  if (!demoMode) return {};
  return {
    tenantId: DEMO_TENANT_ID,
    OR: [
      { status: { notIn: [...FINISHED_JOB_STATUSES] } },
      { vehicle: { registration: DEMO_REFERENCE_DRIVER.registration } },
    ],
  };
}

export function demoUnitWhere(demoMode: boolean = config.demoMode): Prisma.UnitWhereInput {
  if (!demoMode) return {};
  return { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } };
}

export function demoTechnicianWhere(demoMode: boolean = config.demoMode): Prisma.TechnicianWhereInput {
  if (!demoMode) return {};
  return { employeeCode: { in: DEMO_CREWS.map((crew) => crew.employeeCode) } };
}

// No depots on the demo board: crew C's missing part has to stay missing.
export function demoDepotWhere(demoMode: boolean = config.demoMode): Prisma.DepotWhereInput {
  if (!demoMode) return {};
  return { id: { in: [] } };
}

export function demoWorkshopWhere(demoMode: boolean = config.demoMode): Prisma.WorkshopWhereInput {
  if (!demoMode) return {};
  return { code: DEMO_WORKSHOP.code };
}
