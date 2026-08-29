// CREWING — who is sitting in each van right now.
//
// `Unit.currentTechnicianId` is what makes the technician surface real. Manual
// assignment (and, from Phase 9, the solver) copies it onto
// `Job.assignedTechnicianId`, and row ownership then narrows a technician's job
// list to the jobs their unit is on. With every unit uncrewed, that field lands
// null and the technician page is permanently empty however many jobs are
// dispatched.
//
// THE MATCHING RULE, and why it is not "the technician can do everything the
// van can". Units are equipped generously on purpose — an EV van carries the
// high-voltage kit AND brake tools AND a key programmer — while no single
// technician holds all of those, by design (see the scarcity comments in
// technicians.ts). A pairing can do the INTERSECTION of the two, so requiring
// a technician to cover the whole van would leave the specialist vans
// permanently uncrewed.
//
// What matters instead is that the van's SCARCEST capability is usable: putting
// a non-certified technician in the EV van wastes the only two EV vans in the
// fleet. So each unit is crewed by someone who holds its rarest capability,
// with the rarest units filled first — otherwise a general technician takes the
// EV van and the certified pair end up on bikes.
//
// Ties break toward the unit's own zone, then toward whichever shift band is
// least represented so far (so the fleet is crewed across the day rather than
// all mornings), then on technician number. Every step is deterministic, so the
// same seed run twice produces the same crews.

import type { PrismaClient } from '@prisma/client';
import { technicianPlan } from './technicians.js';
import type { TechnicianPlan } from './technicians.js';
import { unitPlanEntries } from './fleet.js';
import type { UnitPlanEntry } from './fleet.js';

type Crewing = { unitId: string; technicianId: string };

function holdersOf(capability: string, technicians: TechnicianPlan[]): number {
  return technicians.filter((technician) => technician.capabilities.includes(capability)).length;
}

// The capability on this unit that the fewest technicians in the workforce
// hold. Ties break alphabetically so the choice is stable.
function rarestCapability(unit: UnitPlanEntry, technicians: TechnicianPlan[]): string {
  const ranked = [...unit.capabilities].sort((a, b) => {
    const difference = holdersOf(a, technicians) - holdersOf(b, technicians);
    if (difference !== 0) return difference;
    return a.localeCompare(b);
  });
  return ranked[0]!;
}

// Hardest to crew first. A unit whose rarest capability only two people hold
// must choose before one that anybody can crew, or the scarce technicians get
// used up on vans that did not need them.
//
// HONEST NOTE: with the fleet as it is numbered today this ordering changes
// NOTHING — the specialist vans are already unit-01 upward, so natural order
// happens to be scarcity order, and removing this sort produces byte-identical
// crews. It is kept because it is what makes the algorithm correct rather than
// lucky: renumber the fleet, or add a specialist unit at the end, and without
// it a general technician takes the EV van. No test can distinguish the two
// today, so nothing here should be read as proof that it is load-bearing.
function byScarcityThenNumber(technicians: TechnicianPlan[]) {
  return (a: UnitPlanEntry, b: UnitPlanEntry): number => {
    const scarcity =
      holdersOf(rarestCapability(a, technicians), technicians) -
      holdersOf(rarestCapability(b, technicians), technicians);
    if (scarcity !== 0) return scarcity;
    return a.unitId.localeCompare(b.unitId);
  };
}

function pickCrew(
  unit: UnitPlanEntry,
  available: TechnicianPlan[],
  bandCounts: Map<string, number>,
): TechnicianPlan | null {
  const needed = rarestCapability(unit, available);
  const qualified = available.filter((technician) => technician.capabilities.includes(needed));
  if (qualified.length === 0) return null;

  // Prefer the unit's own zone, but never at the cost of leaving it uncrewed.
  const sameZone = qualified.filter((technician) => technician.homeZoneId === unit.zoneId);
  const shortlist = sameZone.length > 0 ? sameZone : qualified;

  const sorted = [...shortlist].sort((a, b) => {
    const spread = (bandCounts.get(a.band) ?? 0) - (bandCounts.get(b.band) ?? 0);
    if (spread !== 0) return spread;
    return a.index - b.index;
  });
  return sorted[0]!;
}

// Pure: works out the whole crew list without touching the database, so it can
// be reasoned about and tested on its own.
export function planCrews(): Crewing[] {
  const technicians = technicianPlan();
  const units = [...unitPlanEntries()].sort(byScarcityThenNumber(technicians));

  const available = [...technicians];
  const bandCounts = new Map<string, number>();
  const crews: Crewing[] = [];

  for (const unit of units) {
    // `rarestCapability` is measured against the WHOLE workforce, not the
    // remaining pool — scarcity is a property of the fleet, and recomputing it
    // as people are taken would reorder the units mid-pass.
    const chosen = pickCrew(unit, available, bandCounts);
    if (!chosen) continue;

    crews.push({ unitId: unit.unitId, technicianId: chosen.technicianId });
    bandCounts.set(chosen.band, (bandCounts.get(chosen.band) ?? 0) + 1);
    available.splice(available.indexOf(chosen), 1);
  }

  return crews.sort((a, b) => a.unitId.localeCompare(b.unitId));
}

export async function seedCrews(prisma: PrismaClient): Promise<void> {
  const crews = planCrews();
  const plannedFor = new Map(crews.map((crew) => [crew.unitId, crew.technicianId]));

  // TWO PASSES, because `current_technician_id` is UNIQUE. Writing the new
  // crewing straight over an old one collides the moment a technician moves
  // between units: for an instant two rows would claim the same person, and the
  // constraint rejects it. Clearing first means the second pass always writes
  // into empty space. This is what keeps the seed re-runnable after a test or a
  // previous version has left different crews behind.
  const units = await prisma.unit.findMany({
    where: { id: { in: [...plannedFor.keys()] } },
    select: { id: true, currentTechnicianId: true },
  });

  for (const unit of units) {
    if (unit.currentTechnicianId && unit.currentTechnicianId !== plannedFor.get(unit.id)) {
      await prisma.unit.update({ where: { id: unit.id }, data: { currentTechnicianId: null } });
    }
  }

  for (const crew of crews) {
    await prisma.unit.update({
      where: { id: crew.unitId },
      data: { currentTechnicianId: crew.technicianId },
    });
  }
}
