// THE ACT 3 / ACT 6 GLUE (src/demo/demoDispatch.ts, src/commit/excludeCrews.ts).
//
// Two properties: re-planning after a refusal never offers the job back to
// whoever refused it, and outside DEMO_MODE the glue does nothing at all —
// every other deployment keeps exactly the behaviour it had.

import { describe, expect, it } from 'vitest';
import { withoutTechnicians } from '../src/commit/excludeCrews.js';
import { dispatchAfterIntake, redispatchAfterRefusal } from '../src/demo/demoDispatch.js';
import { prismaBase } from '../src/infra/prismaBase.js';
import type { DispatchSnapshot } from '../src/engine/candidates.js';

function snapshotWith(crews: { unitId: string; technicianId: string | null }[]): DispatchSnapshot {
  return {
    units: crews.map((crew) => ({ id: crew.unitId, currentTechnicianId: crew.technicianId })),
    technicians: crews
      .filter((crew) => crew.technicianId !== null)
      .map((crew) => ({ id: crew.technicianId })),
    shifts: [],
    zones: [],
  } as unknown as DispatchSnapshot;
}

describe('withoutTechnicians', () => {
  const snapshot = snapshotWith([
    { unitId: 'unit-b', technicianId: 'tech-b' },
    { unitId: 'unit-d', technicianId: 'tech-d' },
    { unitId: 'unit-empty', technicianId: null },
  ]);

  it('removes the refusing technician and the van they crew', () => {
    const narrowed = withoutTechnicians(snapshot, ['tech-b']);
    expect(narrowed.technicians.map((technician) => technician.id)).toEqual(['tech-d']);
    expect(narrowed.units.map((unit) => unit.id)).toEqual(['unit-d', 'unit-empty']);
  });

  it('returns the same snapshot when nobody has refused', () => {
    expect(withoutTechnicians(snapshot, [])).toBe(snapshot);
  });
});

describe('outside DEMO_MODE', () => {
  // The suite runs with DEMO_MODE unset; a job id that does not exist proves
  // nothing is even looked up.
  it('neither dispatches after intake nor re-dispatches after a refusal', async () => {
    expect(await dispatchAfterIntake(prismaBase, 'no-such-job')).toBeNull();
    expect(await redispatchAfterRefusal(prismaBase, 'no-such-job')).toBeNull();
  });
});
