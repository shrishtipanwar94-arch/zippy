// Crewing: which technician is in which unit.
//
// Pure — `planCrews()` works the pairing out from the seed's own plan data and
// touches nothing. The point of testing it is that the pairing is easy to break
// silently: change a capability range in technicians.ts or fleet.ts and the
// seed still runs, still reports 24/24 crewed, and quietly puts a general
// technician in the only EV van.

import { describe, expect, it } from 'vitest';
import { planCrews } from '../prisma/seed/crews.js';
import { technicianPlan } from '../prisma/seed/technicians.js';
import { unitPlanEntries } from '../prisma/seed/fleet.js';

const crews = planCrews();
const technicians = new Map(technicianPlan().map((entry) => [entry.technicianId, entry]));
const units = new Map(unitPlanEntries().map((entry) => [entry.unitId, entry]));

function holdersOf(capability: string): number {
  return [...technicians.values()].filter((technician) =>
    technician.capabilities.includes(capability),
  ).length;
}

describe('crewing the fleet', () => {
  it('crews every seeded unit', () => {
    expect(crews).toHaveLength(units.size);
    expect(new Set(crews.map((crew) => crew.unitId)).size).toBe(units.size);
  });

  // `Unit.currentTechnicianId` is UNIQUE, so a plan that used anyone twice
  // would not merely be wrong, it would fail to write.
  it('never puts one technician in two units', () => {
    const assigned = crews.map((crew) => crew.technicianId);
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  // THE RULE. Not "the crew can do everything the van can" — no technician
  // holds EV certification AND brake tools, by design — but "the crew can use
  // the scarcest thing the van carries", which is what stops a general
  // technician being sat in the only EV van.
  it('gives every unit a crew who can use its rarest capability', () => {
    for (const crew of crews) {
      const unit = units.get(crew.unitId)!;
      const technician = technicians.get(crew.technicianId)!;

      const rarest = [...unit.capabilities].sort((a, b) => {
        const difference = holdersOf(a) - holdersOf(b);
        return difference !== 0 ? difference : a.localeCompare(b);
      })[0]!;

      expect(technician.capabilities, `${unit.unitId} needs ${rarest}`).toContain(rarest);
    }
  });

  // The scarce pairings are the whole reason the seed is shaped this way: two
  // EV vans, two certified technicians, and they must end up together.
  it('puts the two EV-certified technicians in the two EV vans', () => {
    const evUnits = [...units.values()]
      .filter((unit) => unit.capabilities.includes('EV_HV_CERTIFICATION'))
      .map((unit) => unit.unitId);
    expect(evUnits).toHaveLength(2);

    for (const unitId of evUnits) {
      const crew = crews.find((candidate) => candidate.unitId === unitId)!;
      expect(technicians.get(crew.technicianId)!.capabilities).toContain('EV_HV_CERTIFICATION');
    }
  });

  it('puts flatbed-qualified technicians in the flatbeds', () => {
    const flatbeds = [...units.values()].filter((unit) => unit.kind === 'FLATBED_TOW');
    expect(flatbeds).toHaveLength(4);

    for (const unit of flatbeds) {
      const crew = crews.find((candidate) => candidate.unitId === unit.unitId)!;
      expect(technicians.get(crew.technicianId)!.capabilities).toContain('FLATBED_LOADING');
    }
  });

  it('crews each unit from its own zone', () => {
    for (const crew of crews) {
      expect(technicians.get(crew.technicianId)!.homeZoneId).toBe(units.get(crew.unitId)!.zoneId);
    }
  });

  // Not all on mornings: a fleet crewed by one shift band is a fleet that stops
  // existing at 14:00.
  it('spreads crews across more than one shift band', () => {
    const bands = new Set(crews.map((crew) => technicians.get(crew.technicianId)!.band));
    expect(bands.size).toBeGreaterThan(2);
  });

  // The seed must be safe to run twice, which starts with the plan being the
  // same both times.
  it('is deterministic', () => {
    expect(planCrews()).toEqual(planCrews());
  });
});
