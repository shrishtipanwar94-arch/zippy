// THE COMPETING PLANS, side by side, and the choice between them.
//
// A dispatcher does not pick a van from a list; they compare whole plans —
// the same feasible options assigned several different ways under the named
// weight vectors — and take one. The interesting number is not any single
// assignment but what a plan gives up: how many jobs it leaves unassigned and
// what it costs in total.
//
// AND WHO IT LEAVES WAITING. PROTECT_CONTRACTS (Phase 20) buys a lower
// contract-breach exposure with consumer jobs the recommended plan would have
// served, and every one of them is named on the card BEFORE the button. A
// dispatcher taking that plan is making a commercial choice about a person
// standing beside a broken car, and a tool that made it look like a free
// optimisation would be lying to them.
//
// ONE PLAN IS RECOMMENDED, THE REST ARE OVERRIDES. BALANCED is what the solver
// puts forward, and it is the vector the Phase 10 harness measures, so "the
// recommendation" means the same thing to the evaluation and to this screen.
// Taking BALANCED needs no explanation. Taking any other plan is a judgement
// the model did not make — a road closed ten minutes ago, a customer who has
// already waited twice, a fleet whose contract cannot take another breach —
// and that judgement has to be written down, or "why did we send the slower
// van?" is unanswerable six weeks later.
//
// So the reason box appears only on the override plans, and the server refuses
// the selection without it (422). The asymmetry is the design: the common case
// is frictionless, the exceptional case explains itself.
//
// TAKING A PLAN IS NOT DISPATCHING IT, and this panel now says so out loud —
// see `whereDispatchHappens` at the foot of the render for the full account.
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

  panel.replaceChildren(
    ...state.solve.plans.map((plan) => planCard(plan, state)),
    whereDispatchHappens(),
  );
}

// WHAT THIS BUTTON DOES, AND WHAT IT DOES NOT.
//
// It said "Select this plan" and looked exactly like a commit. It is not one:
// `POST /plans/:id/select` writes a decision_records row per assignment and a
// PLAN_SELECTED (or PLAN_OVERRIDDEN) event, and stops. No unit is held, no
// offer is sent, no job row changes — see src/commit/decisionRecords.ts, which
// imports neither the saga nor the offer module.
//
// A walkthrough was lost to exactly this: a job was created, solved and
// selected, and the technician's screen stayed empty, because the only path
// into the reservation saga is executing a REASSIGN_* action from the action
// queue (src/api/actions.ts -> executeReassignment). That gap is real and is
// written up in INTERVIEW.md; it is not this panel's to close. What this panel
// can do is stop implying otherwise, which is what the label and this line are.
function whereDispatchHappens() {
  const note = document.createElement('div');
  note.className = 'col-12';
  note.innerHTML =
    '<p class="small text-muted mb-0">' +
    'Recording a decision does not dispatch anybody: it writes the choice and why, ' +
    'against every job in the plan. A crew is reserved and offered when a ' +
    '<strong>reassignment action is executed from the action queue</strong>.' +
    '</p>';
  return note;
}

function planCard(plan, state) {
  const card = document.createElement('div');
  // Three to a row at desktop width, wrapping as vectors are added. The count
  // is WEIGHT_VECTORS' business, not this file's.
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
    ? `<div class="small" style="color:var(--accent)">${plan.unassignedJobIds.length} job(s) unassigned</div>
       <div class="small text-muted">${escapeHtml(describeUnassigned(plan.unassignedJobIds, state.solve.rejected))}</div>`
    : '<div class="small" style="color:var(--ok)">all jobs assigned</div>';

  const deprioritised = plan.deprioritisedConsumerJobIds ?? [];
  const tradeOffWarning = deprioritised.length
    ? `<div class="alert alert-warning p-2 my-2 small mb-0">
         <strong>Deprioritises ${deprioritised.length} consumer job(s)</strong>
         that ${escapeHtml(RECOMMENDED)} would have served:
         ${deprioritised.map((jobId) => `<code>${escapeHtml(jobId.slice(-6))}</code>`).join(' ')}
       </div>`
    : '';

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
        ${tradeOffWarning}
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
          ${isSelected ? 'decision recorded' : 'Record this decision'}
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

// WHY THOSE JOBS ARE UNASSIGNED, not just how many.
//
// "10 job(s) unassigned" is the weakest-looking number on this screen and it is
// actually the strongest argument the project has. Dispatch is hard here not
// because the solver is bad but because capability is scarce and lumpy, and the
// reason codes say so precisely: six jobs waiting on the one technician with an
// EV certificate is a fleet-composition fact, not a planning failure. Stating
// it out loud turns a number somebody would poke at into the point being made.
//
// COUNTS JOBS, NOT REJECTED OPTIONS. `describeRejectionCounts` on the server
// counts options for ONE job — twenty-three units all off shift is "x23". Here
// the useful unit is the job: each unassigned job contributes its single
// dominant reason, so the counts add up to the unassigned total and can be read
// as "six of the ten".
//
// PHRASES LIVE HERE AND ARE ASSERTED AGAINST THE ENGINE. Same arrangement as
// ACTION_LABELS in actions.js: the console has no build step and cannot import
// the server's types, so the map is duplicated and tests/consolePanels.test.ts
// asserts it covers every RejectionCode. Duplication a test catches beats a
// bundler.
const REJECTION_PHRASES = {
  UNIT_UNAVAILABLE: 'every capable unit is already on a job',
  VEHICLE_TYPE_INCOMPATIBLE: 'no unit can handle the vehicle',
  CAPABILITY_MISSING: 'no crew holds the skills the fault needs',
  ACCESS_RESTRICTION: 'no unit can physically reach the vehicle',
  NO_TECHNICIAN_ON_SHIFT: 'capable units have no technician on shift',
  SLA_UNREACHABLE: 'unreachable within SLA',
  PART_UNAVAILABLE: 'the part is not in any van in range',
  NO_DESTINATION_AVAILABLE: 'no workshop can take it',
  DESTINATION_NOT_AUTHORISED: 'no authorised destination',
  DESTINATION_EV_CLASS_MISMATCH: 'no destination certified for the EV class',
  TENANT_CONTRACT_EXCLUDES: 'the contract excludes this work',
};

// The one reason to give a job, when its options were refused for several. The
// most common one, ties broken by name so the sentence is stable between
// renders of the same solve.
function dominantReason(codes) {
  const counts = new Map();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);

  let best = null;
  let bestCount = 0;
  for (const [code, count] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}

export function describeUnassigned(unassignedJobIds, rejected) {
  const codesByJob = new Map();
  for (const jobId of unassignedJobIds) codesByJob.set(jobId, []);
  for (const rejection of rejected ?? []) {
    const codes = codesByJob.get(rejection.jobId);
    if (codes) codes.push(rejection.code);
  }

  const jobsByReason = new Map();
  let unexplained = 0;
  for (const codes of codesByJob.values()) {
    const code = dominantReason(codes);
    // A job with no rejections at all was not refused — it lost to another job
    // for a unit both could have taken. That is contention, not infeasibility,
    // and calling it a reason code would be inventing one.
    if (!code) {
      unexplained += 1;
      continue;
    }
    jobsByReason.set(code, (jobsByReason.get(code) ?? 0) + 1);
  }

  const parts = [...jobsByReason.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} ${REJECTION_PHRASES[code] ?? code}`);

  if (unexplained > 0) {
    parts.push(`${unexplained} lost a unit to a higher-priority job`);
  }

  return parts.join(' · ');
}

export { REJECTION_PHRASES };
