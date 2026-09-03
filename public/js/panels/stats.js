// THE STAT STRIP — three numbers, at the top, that report rather than compete.
//
// The console carries a dozen panels and, before this pass, opened on all of
// them at equal weight. This strip is the answer to "is anything wrong right
// now" before a dispatcher has read anything else, and it is deliberately the
// smallest thing on the page that is not muted: three figures, no chart, no
// trend arrow, no colour unless the number is one worth acting on.
//
// EVERY FIGURE HERE IS A POPULATION, AND POPULATIONS ARE COUNTED SERVER-SIDE.
//
// This strip used to be counted in the browser from the arrays the panels
// below render, on the argument that the strip then could not disagree with
// them. That argument was wrong, and quietly: those arrays are PAGES. GET
// /jobs returns the newest fifty and GET /queue returns the top fifty, so
// "active incidents" read 50 on a board of nine thousand and 50 again on a
// board of sixty — a number that cannot move is not a report, and it was most
// wrong exactly when the board was busiest.
//
// So the rule for this file is now one line long: if a figure describes the
// board, the server counts it over the board. The strip renders what it is
// told and derives nothing.
//
//   active incidents  — /queue activeIncidentCount   every non-finished job
//   SLA at risk       — /queue slaAtRiskCount        every pending job
//   pending approvals — /actions                     unbounded: the whole set
//
// The third is the exception that proves the rule rather than a hole in it:
// GET /actions has no `take` and returns every PENDING row across every job,
// so counting the array IS counting the population. It is audited here, in
// comment, so the next person does not have to re-derive it.

// Each figure keeps a browser-side fallback for one narrow case: a response
// that predates the field. Showing a stale-but-shaped number beats showing a
// blank strip, and the fallbacks are labelled so nobody mistakes them for the
// primary path.
const FINISHED = new Set(['RESOLVED', 'CANCELLED', 'UNSERVICEABLE']);

// Three quarters of the promised window gone. The same threshold the queue's
// own SLA badge turns amber at, so the strip and the rows agree about what
// "at risk" means. src/domain/priority.ts holds the authoritative copy.
const SLA_AT_RISK = 0.75;

export function render(state) {
  const panel = document.querySelector('[data-panel="stats"]');
  if (!panel) return;

  panel.hidden = !state.session;
  if (panel.hidden) return;

  // Fallback counts the newest fifty from GET /jobs, which is a page — see the
  // note at the top of this file. It exists only for a response that predates
  // `activeIncidentCount`, and it under-reports whenever it fires.
  const active = Number.isFinite(state.queue.activeIncidentCount)
    ? state.queue.activeIncidentCount
    : Object.values(state.jobs).filter((job) => !FINISHED.has(job.status)).length;

  // Same shape, same reason: the fallback filters the top fifty and would
  // report "at risk among the fifty most urgent".
  const atRisk = Number.isFinite(state.queue.slaAtRiskCount)
    ? state.queue.slaAtRiskCount
    : state.queue.jobs.filter((job) => job.slaRisk >= SLA_AT_RISK).length;

  // No fallback needed: GET /actions is unbounded, so this array is the
  // population rather than a page of it.
  const approvals = (state.actions ?? []).filter((action) => action.tier === 'APPROVE').length;

  setStat(panel, 'active', active, false);
  // Both of these are amber when non-zero and plain when not: a zero is not
  // news, and a strip that is permanently coloured is a strip nobody reads.
  setStat(panel, 'sla-risk', atRisk, atRisk > 0);
  setStat(panel, 'approvals', approvals, approvals > 0);
}

function setStat(panel, field, value, urgent) {
  const node = panel.querySelector(`[data-field="stat-${field}"]`);
  if (!node) return;
  const text = String(value);
  if (node.textContent !== text) node.textContent = text;
  if (node.classList.contains('is-urgent') !== urgent) {
    node.classList.toggle('is-urgent', urgent);
  }
}
