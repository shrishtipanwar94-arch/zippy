// A SNAPSHOT WITHOUT CERTAIN TECHNICIANS — for re-planning a job somebody has
// just refused.
//
// When a technician declines an offer, or lets it time out, the reservation
// is unwound and the job goes back on the board. Re-solving it against the
// full snapshot would hand it straight back to the same technician: nothing
// about the van, the distance or the skills changed, only their answer. So the
// re-plan after a refusal is run against a copy of the snapshot with the
// refusing technicians — and the vans they crew — taken out.
//
// Done here, to the snapshot, rather than in the engine: the solver stays a
// pure function of what it is shown (invariant 2), and "do not ask this person
// about this job again" is a fact about the job's history, which is the
// commit layer's to read.

import type { DispatchSnapshot } from '../engine/candidates.js';

export function withoutTechnicians(snapshot: DispatchSnapshot, technicianIds: string[]): DispatchSnapshot {
  if (technicianIds.length === 0) return snapshot;
  const excluded = new Set(technicianIds);

  const technicians = snapshot.technicians.filter((technician) => !excluded.has(technician.id));
  const units = snapshot.units.filter(
    (unit) => unit.currentTechnicianId === null || !excluded.has(unit.currentTechnicianId),
  );
  return { ...snapshot, technicians, units };
}
