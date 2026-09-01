// DID THIS INCIDENT MEET ITS SLA WINDOW — one job at a time, and only when the
// question has an answer.
//
// THE FOURTH STATE IS THE POINT. "Met" and "breached" are the two answers a
// dashboard wants, but a job still inside its window with nobody there yet is
// neither — it has not happened yet, and counting it either way would make
// "SLA met %" swing on jobs that are still in progress rather than on jobs
// that are actually decided. UNDECIDED exists so the fleet dashboard's
// percentage (src/commit/fleetDashboard.ts) can exclude exactly those jobs
// from the denominator — the same move evaluation/metrics.ts makes measuring
// resolution time only over jobs that finished.
//
// Pure. No database, no clock reads — `now` is passed in so a test can freeze
// it.

export type SlaOutcome = 'MET' | 'BREACHED' | 'UNDECIDED' | 'NOT_APPLICABLE';

export type SlaOutcomeInput = {
  createdAt: Date;
  // Null means this job carries no contract response window — a walk-in, or a
  // fleet job whose contract lapsed before it was pinned one. Nothing to
  // measure.
  responseMinutes: number | null;
  // The `TECHNICIAN_ARRIVED` event's timestamp, if one has been recorded —
  // src/commit/technicianActions.ts writes it, and this is the only fact this
  // function needs about arrival: not the job's current status, which can
  // change for reasons that have nothing to do with when the crew showed up.
  arrivedAt: Date | null;
  now: Date;
};

export function slaOutcomeFor(input: SlaOutcomeInput): SlaOutcome {
  if (input.responseMinutes === null) return 'NOT_APPLICABLE';

  const deadline = new Date(input.createdAt.getTime() + input.responseMinutes * 60_000);

  if (input.arrivedAt !== null) {
    return input.arrivedAt <= deadline ? 'MET' : 'BREACHED';
  }

  // Nobody has arrived. The window closing is itself the decision — a promise
  // that has not been kept by its deadline is broken whether or not a van ever
  // shows up afterwards, the same rule src/engine/feasibility.ts's SLA check
  // and src/commit/slaEscalation.ts both already apply.
  return input.now > deadline ? 'BREACHED' : 'UNDECIDED';
}
