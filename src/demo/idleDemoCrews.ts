// THE DEMO CREWS THAT ARE SAFE TO REFRESH RIGHT NOW: present in the database,
// and not on a live job.
//
// Rows are found by their natural keys — the employee codes and unit codes in
// DEMO_CREWS — so nothing outside the demo board can ever be selected here,
// whatever ids the rest of the fleet happens to use.

import type { PrismaClient } from '@prisma/client';
import { DEMO_CREWS } from './demoCrews.js';
import type { DemoCrew } from './demoCrews.js';
import { findBusyUnitIds } from './busyDemoUnits.js';

export type IdleDemoCrew = { crew: DemoCrew; technicianId: string; unitId: string };

export async function findIdleDemoCrews(db: PrismaClient): Promise<IdleDemoCrew[]> {
  const technicians = await db.technician.findMany({
    where: { employeeCode: { in: DEMO_CREWS.map((crew) => crew.employeeCode) } },
    select: { id: true, employeeCode: true },
  });
  const units = await db.unit.findMany({
    where: { code: { in: DEMO_CREWS.map((crew) => crew.unitCode) } },
    select: { id: true, code: true },
  });
  const busy = await findBusyUnitIds(db, units.map((unit) => unit.id));

  const idle: IdleDemoCrew[] = [];
  for (const crew of DEMO_CREWS) {
    const technician = technicians.find((row) => row.employeeCode === crew.employeeCode);
    const unit = units.find((row) => row.code === crew.unitCode);
    // Not seeded yet: nothing to refresh. The web process's boot will create it.
    if (!technician || !unit) continue;
    if (busy.has(unit.id)) continue;
    idle.push({ crew, technicianId: technician.id, unitId: unit.id });
  }
  return idle;
}
