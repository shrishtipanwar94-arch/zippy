// THE FLEET THE HARNESS EVALUATES, built from the seed's own plan functions.
//
// `technicianPlan()`, `unitPlanEntries()` and `planCrews()` are the pure
// halves of prisma/seed — the same functions `npm run db:seed` writes rows
// from, with no database anywhere near them. Using them means the evaluated
// fleet IS the seeded fleet: the same uneven capability matrix (exactly 2 EV
// certifications, 3 key programmers, 18 OBD), the same crewing rule, the same
// six zones. A fleet invented here instead would measure a world that does
// not exist.
//
// Everything is a plain object. No Prisma, no Redis, no clock.

import { technicianPlan, shiftPlan } from '../../prisma/seed/technicians.js';
import { unitPlanEntries } from '../../prisma/seed/fleet.js';
import { planCrews } from '../../prisma/seed/crews.js';
import { ZONES } from '../../prisma/seed/zones.js';
import type {
  DispatchSnapshot,
  UnitKindSnapshot,
  ZoneSnapshot,
} from '../../src/engine/candidates.js';

// The knobs the sweep varies. Each one narrows the seeded fleet rather than
// inventing a different one, so a swept run stays comparable to the base run.
export type FleetShape = {
  // How many of the seeded units are in service. 24 is the whole fleet.
  unitCount: number;
  // How many technicians exist. Fewer technicians means fewer crewed units,
  // because a unit with no crew produces no candidate at all.
  technicianCount: number;
  // Capability codes stripped from every technician who is not among the
  // first `scarceHolders` holders of that code. This is how the sweep makes a
  // skill scarcer without rewriting the capability matrix by hand.
  scarcity: { code: string; holders: number }[];
};

export const FULL_FLEET: FleetShape = {
  unitCount: 24,
  technicianCount: 31,
  scarcity: [],
};

export function zoneSnapshots(): ZoneSnapshot[] {
  return ZONES.map((zone) => ({
    id: `zone-${zone.code.toLowerCase()}`,
    centroidLat: zone.lat,
    centroidLng: zone.lng,
  }));
}

// Apply the scarcity knob: keep a capability only on the first N technicians
// that hold it, in plan order, and strip it from everyone else.
function applyScarcity(
  capabilities: string[],
  technicianId: string,
  keepers: Map<string, Set<string>>,
): string[] {
  return capabilities.filter((code) => {
    const allowed = keepers.get(code);
    return !allowed || allowed.has(technicianId);
  });
}

function scarcityKeepers(shape: FleetShape): Map<string, Set<string>> {
  const keepers = new Map<string, Set<string>>();
  for (const rule of shape.scarcity) {
    const holders = technicianPlan()
      .filter((technician) => technician.capabilities.includes(rule.code))
      .slice(0, rule.holders)
      .map((technician) => technician.technicianId);
    keepers.set(rule.code, new Set(holders));
  }
  return keepers;
}

// A fleet frozen at one instant. `at` matters because shift windows are
// absolute times and feasibility asks whether a technician is on shift NOW.
export function buildSnapshot(shape: FleetShape, at: Date): DispatchSnapshot {
  const keepers = scarcityKeepers(shape);

  const technicians = technicianPlan()
    .slice(0, shape.technicianCount)
    .map((technician) => ({
      id: technician.technicianId,
      capabilityCodes: applyScarcity(
        technician.capabilities,
        technician.technicianId,
        keepers,
      ),
    }));
  const technicianIds = new Set(technicians.map((technician) => technician.id));

  const crewByUnit = new Map(planCrews().map((crew) => [crew.unitId, crew.technicianId]));
  const zones = zoneSnapshots();
  const zoneById = new Map(zones.map((zone) => [zone.id, zone]));

  const units = unitPlanEntries()
    .slice(0, shape.unitCount)
    .map((unit) => {
      const crew = crewByUnit.get(unit.unitId) ?? null;
      const zone = zoneById.get(unit.zoneId);
      return {
        id: unit.unitId,
        zoneId: unit.zoneId,
        // A crew who was cut by `technicianCount` leaves the unit uncrewed,
        // which is exactly what thinning the workforce should do.
        currentTechnicianId: crew && technicianIds.has(crew) ? crew : null,
        capabilityCodes: unit.capabilities,
        // Units start parked at their zone centroid. The runner moves them as
        // they complete jobs.
        lat: zone?.centroidLat ?? null,
        lng: zone?.centroidLng ?? null,
        kind: unit.kind as UnitKindSnapshot,
        status: 'AVAILABLE' as const,
      };
    });

  // Shift windows come from the seed too, so "who is on duty" is the same
  // question the production feasibility filter answers against real rows.
  // Anchored to `at` rather than to the wall clock: a scenario replayed
  // tomorrow must see the same fleet on duty as one replayed today.
  const shifts = shiftPlan()
    .filter((window) => technicianIds.has(window.technicianId))
    .map((window) => rebaseShift(window, at));

  return { units, technicians, shifts, zones };
}

// Move a shift window onto the scenario's own day, preserving its hours.
// `shiftPlan()` anchors to the real "today"; a harness run must not produce a
// different answer because it happened to run at 03:00 rather than 15:00.
function rebaseShift(
  window: { technicianId: string; startsAt: Date; endsAt: Date },
  at: Date,
): { technicianId: string; startsAt: Date; endsAt: Date } {
  const dayLength = 24 * 60 * 60 * 1000;
  const anchor = new Date(at);
  anchor.setHours(0, 0, 0, 0);

  const planDay = new Date(window.startsAt);
  planDay.setHours(0, 0, 0, 0);

  const offset = anchor.getTime() - planDay.getTime();
  const wholeDays = Math.round(offset / dayLength) * dayLength;

  return {
    technicianId: window.technicianId,
    startsAt: new Date(window.startsAt.getTime() + wholeDays),
    endsAt: new Date(window.endsAt.getTime() + wholeDays),
  };
}
