// THE STAT STRIP — three numbers, at the top, that report rather than compete.
//
// The console carries a dozen panels and, before this pass, opened on all of
// them at equal weight. This strip is the answer to "is anything wrong right
// now" before a dispatcher has read anything else, and it is deliberately the
// smallest thing on the page that is not muted: three figures, no chart, no
// trend arrow, no colour unless the number is one worth acting on.
//
// DERIVED FROM STATE THE PAGE ALREADY HOLDS, not from an endpoint of its own.
// Every figure below is counted from the same objects the panels underneath
// render, so the strip cannot disagree with them — it is the same data read at
// a different altitude. That is also the honest limit: these are the first
// numbers on this console not computed server-side, and if anything else ever
// needs them they should move to a route. See DECISIONS.log.

// A job the board has finished with. Counted out rather than counting statuses
// in, so a status added later shows up as active — which is the safe direction
// to be wrong in on a strip that says "how much is happening".
const FINISHED = new Set(['RESOLVED', 'CANCELLED', 'UNSERVICEABLE']);

// Three quarters of the promised window gone. The same threshold the queue's
// own SLA badge turns amber at, so the strip and the rows agree about what
// "at risk" means.
const SLA_AT_RISK = 0.75;

export function render(state) {
  const panel = document.querySelector('[data-panel="stats"]');
  if (!panel) return;

  panel.hidden = !state.session;
  if (panel.hidden) return;

  const active = Object.values(state.jobs).filter((job) => !FINISHED.has(job.status)).length;
  const atRisk = state.queue.jobs.filter((job) => job.slaRisk >= SLA_AT_RISK).length;
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
