// THE THREE PLANS — what replaced the Phase 4 unit dropdown.
//
// A dispatcher no longer picks a van from a list of every available unit.
// They see the same feasible options assigned three different ways —
// FASTEST_RESOLUTION, LOWEST_COST, BALANCED — and compare whole plans. The
// interesting number is not any single assignment but what a plan gives up:
// how many jobs it leaves unassigned, and what it costs in total.
//
// Rebuilt wholesale on each render rather than patched. Unlike the jobs table
// (which updates every few seconds as events arrive and must not lose the
// operator's scroll position), plans only change when someone presses Solve —
// there is nothing to preserve between renders.

export function render(state) {
  const panel = document.querySelector('[data-panel="plans"]');
  if (!panel) return;

  const summary = document.querySelector('[data-field="solve-summary"]');
  if (summary) {
    summary.textContent = state.solve
      ? `${state.solve.jobCount} jobs · ${state.solve.optionCount} options · ` +
        `${state.solve.feasibleCount} feasible · ${state.solve.wallClockMs}ms` +
        (state.solve.zonePartitioned ? ' · ZONE-PARTITIONED' : '')
      : '';
  }

  if (!state.solve || state.solve.plans.length === 0) {
    panel.replaceChildren();
    return;
  }

  panel.replaceChildren(...state.solve.plans.map(planCard));
}

function planCard(plan) {
  const card = document.createElement('div');
  card.className = 'col-md-4';
  card.dataset.plan = plan.label;

  const assignmentRows = plan.assignments
    .map(
      (assignment) =>
        `<tr><td><code>${assignment.jobId.slice(-6)}</code></td>` +
        `<td>${assignment.unitId}</td>` +
        `<td class="text-end">${assignment.cost.total.toFixed(1)}</td></tr>`,
    )
    .join('');

  const unassignedNote = plan.unassignedJobIds.length
    ? `<div class="alert alert-warning py-1 px-2 mb-0 small">` +
      `${plan.unassignedJobIds.length} job(s) unassigned</div>`
    : '<div class="text-success small">all jobs assigned</div>';

  card.innerHTML = `
    <div class="card h-100">
      <div class="card-header">
        <strong>${plan.label}</strong>
        <span class="float-end">total ${plan.totalCost.toFixed(1)}</span>
      </div>
      <div class="card-body p-2">
        ${unassignedNote}
        <table class="table table-sm mb-0">
          <thead><tr><th>job</th><th>unit</th><th class="text-end">cost</th></tr></thead>
          <tbody>${assignmentRows}</tbody>
        </table>
      </div>
    </div>`;

  return card;
}
