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
import { unitPlanEntries, unitStockPlanEntries } from '../../prisma/seed/fleet.js';
import { planCrews } from '../../prisma/seed/crews.js';
import { ZONES } from '../../prisma/seed/zones.js';
import { DEPOTS } from '../../prisma/seed/depots.js';
import { PARTS } from '../../prisma/seed/parts.js';
import type {
  DispatchSnapshot,
  UnitKindSnapshot,
  ZoneSnapshot,
} from '../../src/engine/candidates.js';
import type { PartsSnapshot, PartStockSnapshot } from '../../src/engine/partSourcing.js';
import type { StockConfidence } from '../../src/domain/stockConfidence.js';

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
  // How much of each van's shelf starts EMPTY, 0 to 1, applied
  // deterministically by index. 0 is the seeded fleet with a full kit; the
  // parts-stockout scenario turns it up. Emptying shelves rather than
  // rewriting the kit keeps a depleted run comparable to a stocked one.
  stockDepletion: number;
};

export const FULL_FLEET: FleetShape = {
  unitCount: 24,
  technicianCount: 31,
  scarcity: [],
  stockDepletion: 0,
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

  return { units, technicians, shifts, zones, parts: partsSnapshot(shape) };
}

// ---------------------------------------------------------------------------
// WHAT IS IN THE BACK OF EACH VAN, and how much anybody believes it.
//
// The quantities are the seed's own standard kit (prisma/seed/fleet.ts), so a
// measured run is measuring the fleet that actually exists. The CONFIDENCE
// banding mirrors prisma/seed/vanCounts.ts rather than importing it: a third
// of the fleet counted within the hour, a third counted this morning, a third
// never counted at all. That last third is the interesting one — its stock
// fails closed and is treated as absent, which is exactly the conservatism the
// harness is here to put a number on.
function bandedConfidence(unitNumber: number): StockConfidence {
  const band = unitNumber % 3;
  if (band === 0) return 'VERIFIED';
  if (band === 1) return 'AGEING';
  return 'UNVERIFIED';
}

// Which shelves a depleted fleet has run out of. Deterministic — the same
// shelves are empty on every replay of a seed, so two policies face the same
// shortage rather than two different ones.
function isDepleted(unitNumber: number, shelfIndex: number, depletion: number): boolean {
  if (depletion <= 0) return false;
  return (shelfIndex + unitNumber) % 10 < Math.round(depletion * 10);
}

export function partsSnapshot(shape: FleetShape): PartsSnapshot {
  const inService = new Set(
    unitPlanEntries()
      .slice(0, shape.unitCount)
      .map((unit) => unit.unitId),
  );

  const shelfIndexByUnit = new Map<string, number>();
  const stock: PartStockSnapshot[] = [];

  for (const entry of unitStockPlanEntries()) {
    if (!inService.has(entry.unitId)) continue;

    const unitNumber = Number(entry.unitId.replace(/\D/g, ''));
    const shelfIndex = shelfIndexByUnit.get(entry.unitId) ?? 0;
    shelfIndexByUnit.set(entry.unitId, shelfIndex + 1);

    stock.push({
      unitId: entry.unitId,
      sku: entry.sku,
      quantity: isDepleted(unitNumber, shelfIndex, shape.stockDepletion) ? 0 : entry.quantity,
      confidence: bandedConfidence(unitNumber),
    });
  }

  return {
    stock,
    valuePaiseBySku: Object.fromEntries(PARTS.map((part) => [part.sku, part.pricePaise])),
    depots: DEPOTS.map((depot) => ({
      id: `depot-${depot.code.toLowerCase()}`,
      code: depot.code,
      lat: depot.lat,
      lng: depot.lng,
    })),
  };
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
