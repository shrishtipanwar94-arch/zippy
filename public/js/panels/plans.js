// THE THREE COMPETING PLANS, side by side, and the choice between them.
//
// A dispatcher does not pick a van from a list; they compare whole plans —
// the same feasible options assigned three different ways under three named
// weight vectors — and take one. The interesting number is not any single
// assignment but what a plan gives up: how many jobs it leaves unassigned and
// what it costs in total.
//
// ONE PLAN IS RECOMMENDED, THE OTHER TWO ARE OVERRIDES. BALANCED is what the
// solver puts forward, and it is the vector the Phase 10 harness measures, so
// "the recommendation" means the same thing to the evaluation and to this
// screen. Taking BALANCED needs no explanation. Taking either other plan is a
// judgement the model did not make — a road closed ten minutes ago, a customer
// who has already waited twice — and that judgement has to be written down, or
// "why did we send the slower van?" is unanswerable six weeks later.
//
// So the reason box appears only for the two override plans, and the server
// refuses the selection without it (422). The asymmetry is the design: the
// common case is frictionless, the exceptional case explains itself.
//
// Rebuilt wholesale on each render. Plans change only when someone presses
// Solve, and the reason input is re-seeded from state so a re-render during
// typing does not discard it.

const RECOMMENDED = 'BALANCED';

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

  panel.replaceChildren(...state.solve.plans.map((plan) => planCard(plan, state)));
}

function planCard(plan, state) {
  const card = document.createElement('div');
  card.className = 'col-md-4';
  card.dataset.plan = plan.label;

  const isRecommended = plan.label === RECOMMENDED;
  const selection = state.planSelection;
  const isSelected = selection.label === plan.label;
  const planVariantId = plan.planVariantId ?? '';

  const assignmentRows = plan.assignments
    .map(
      (assignment) =>
        `<tr><td><code>${escapeHtml(assignment.jobId.slice(-6))}</code></td>` +
        `<td class="mono">${escapeHtml(assignment.unitId)}</td>` +
        `<td class="text-end">${assignment.cost.total.toFixed(1)}</td></tr>`,
    )
    .join('');

  const unassignedNote = plan.unassignedJobIds.length
    ? `<div class="small" style="color:var(--accent)">${plan.unassignedJobIds.length} job(s) unassigned</div>`
    : '<div class="small" style="color:var(--ok)">all jobs assigned</div>';

  // The reason box is present only where a reason is required, so the UI and
  // the server agree on when one is needed rather than the browser guessing.
  const overrideBox = isRecommended
    ? ''
    : `<input class="form-control form-control-sm mt-2" data-field="override-reason"
         data-plan="${escapeHtml(plan.label)}"
         placeholder="reason for overriding ${escapeHtml(RECOMMENDED)}"
         value="${escapeHtml(selection.reasonDraft?.[plan.label] ?? '')}" />`;

  card.innerHTML = `
    <div class="card h-100">
      <div class="card-header d-flex gap-2">
        <strong>${escapeHtml(plan.label)}</strong>
        ${isRecommended ? '<span style="color:var(--ok)">recommended</span>' : '<span class="text-muted">override</span>'}
        <span class="ms-auto">total ${plan.totalCost.toFixed(1)}</span>
      </div>
      <div class="card-body p-2">
        ${unassignedNote}
        <div class="small text-muted">${plan.assignments.length} assigned</div>
        <table class="table table-sm mb-0 mt-1">
          <thead><tr><th>job</th><th>unit</th><th class="text-end">cost</th></tr></thead>
          <tbody>${assignmentRows}</tbody>
        </table>
        ${overrideBox}
        <button class="btn btn-sm ${isSelected ? 'btn-success' : 'btn-outline-primary'} mt-2 w-100"
          data-action="select-plan"
          data-plan="${escapeHtml(plan.label)}"
          data-plan-variant-id="${escapeHtml(planVariantId)}"
          ${planVariantId ? '' : 'disabled'}>
          ${isSelected ? 'selected' : 'Select this plan'}
        </button>
        ${planVariantId ? '' : '<div class="small text-muted mt-1">not persisted — re-run Solve</div>'}
      </div>
    </div>`;

  return card;
}

export function renderSelectionError(state) {
  const box = document.querySelector('[data-field="plan-error"]');
  if (!box) return;
  const message = state.planSelection.error;
  box.textContent = message ?? '';
  box.hidden = !message;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
