// "WHY THIS TECHNICIAN?" — the highest-value screen in the product, and the
// cheapest, because every number on it was already written down by Phases 7
// and 8. This panel computes nothing. It renders `dispatch_options` rows: the
// cost breakdown term by term for the option the solver chose, and every
// option it rejected with the reason code that rejected it.
//
// WHY TERM BY TERM RATHER THAN A TOTAL. "Cost 44.2" answers nothing a
// dispatcher asked. The question behind the screen is always comparative —
// "why that van and not the nearer one?" — and the answer is almost always in
// one term: the nearer van scores worse on expected time to resolution because
// it cannot fix half the probability mass. A total hides exactly the term that
// explains the decision, so every term is shown with its own unit and its
// share of the total.
//
// THE REJECTED LIST IS THE OTHER HALF, and arguably the more useful one.
// "Why not the nearer van?" is answered by a row saying
// CAPABILITY_MISSING: missing EV_HV_CERTIFICATION. That is a sentence a
// dispatcher can act on and repeat to a customer; a silently absent option is
// not.
//
// Rebuilt wholesale on each render, unlike the timeline. That is deliberate
// and safe: the inspector shows ONE job's decision, changes only when the
// operator selects a different job, and has no scroll position worth
// preserving across a deliberate selection change.

export function render(state) {
  const panel = document.querySelector('[data-panel="inspector"]');
  if (!panel) return;

  const decision = state.inspector.decision;
  if (!decision) {
    panel.replaceChildren(hint('Select a job from the timeline to see why its crew was chosen.'));
    return;
  }

  const parts = [header(decision)];

  if (!decision.solverRun) {
    parts.push(hint('No solver run has considered this job yet.'));
    panel.replaceChildren(...parts);
    return;
  }

  parts.push(runSummary(decision.solverRun, decision.decisionRecordNote));
  if (decision.hypothesis) parts.push(hypothesisBlock(decision.hypothesis));

  parts.push(sectionTitle(`Chosen (${decision.chosen.length})`));
  if (decision.chosen.length === 0) {
    parts.push(hint('Every option was rejected — see the reason codes below.'));
  }
  for (const option of decision.chosen) parts.push(chosenOption(option));

  parts.push(sectionTitle(`Rejected alternatives (${decision.rejected.length})`));
  parts.push(rejectedTable(decision.rejected));

  panel.replaceChildren(...parts);
}

function header(decision) {
  const box = document.createElement('div');
  box.className = 'mb-2';
  const safety =
    decision.job.safetyLevel === 'NORMAL' ? '' : ` · ${decision.job.safetyLevel}`;
  box.innerHTML =
    `<div class="mono">${escapeHtml(decision.job.id)}</div>` +
    `<div class="text-muted small">${escapeHtml(decision.job.status)}${escapeHtml(safety)} · zone ${escapeHtml(decision.job.zoneId)}</div>`;
  return box;
}

function runSummary(run, note) {
  const box = document.createElement('div');
  box.className = 'small text-muted mb-2';
  box.innerHTML =
    `solver run <span class="mono">${escapeHtml(run.id.slice(-8))}</span> · ` +
    `trigger <span class="mono">${escapeHtml(run.trigger)}</span> · ` +
    `${run.optionCount} options, ${run.feasibleCount} feasible · ${run.wallClockMs}ms` +
    (run.zonePartitioned ? ' · ZONE-PARTITIONED' : '') +
    `<div class="mt-1">${escapeHtml(note ?? '')}</div>`;
  return box;
}

function hypothesisBlock(hypothesis) {
  const box = document.createElement('div');
  box.className = 'small mb-2';

  const top = Object.entries(hypothesis.distribution ?? {})
    .filter(([, probability]) => probability > 0.01)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([fault, probability]) => `${fault} ${(probability * 100).toFixed(0)}%`)
    .join(', ');

  box.innerHTML =
    `<span class="text-muted">believed:</span> ${escapeHtml(top || 'unknown')}` +
    `<br><span class="text-muted">requires:</span> <span class="mono">${escapeHtml(
      (hypothesis.requiredCapabilityCodes ?? []).join(', ') || 'nothing',
    )}</span>`;
  return box;
}

// The cost breakdown, term by term. Each term carries its own unit because
// they are not commensurable — minutes, kilometres, two probabilities and
// paise — and the weights are what convert them, so showing a bare number per
// term would be meaningless.
function chosenOption(option) {
  const box = document.createElement('div');
  box.className = 'card mb-2 chosen-row';

  const breakdown = option.costBreakdown ?? {};
  const total = Number(breakdown.total ?? option.totalCost ?? 0);

  const terms = Object.entries(breakdown)
    .filter(([key, value]) => key !== 'total' && key !== 'weightVector' && value && typeof value === 'object')
    .map(([key, term]) => {
      const contribution = Number(term.weighted ?? term.contribution ?? 0);
      const share = total > 0 ? Math.min(100, Math.abs(contribution / total) * 100) : 0;
      return `
        <tr>
          <td class="mono">${escapeHtml(key)}</td>
          <td class="text-end">${escapeHtml(formatNumber(term.value))} <span class="text-muted">${escapeHtml(term.unit ?? '')}</span></td>
          <td class="text-end">${escapeHtml(formatNumber(contribution))}</td>
          <td style="width:30%"><div class="term-bar" style="width:${share.toFixed(0)}%"></div></td>
        </tr>`;
    })
    .join('');

  box.innerHTML = `
    <div class="card-header d-flex gap-2">
      <span>chosen</span>
      <span class="mono">${escapeHtml(option.unitId)}</span>
      <span class="mono text-muted">${escapeHtml(option.technicianId)}</span>
      <span class="ms-auto">${escapeHtml(String(breakdown.weightVector ?? ''))}</span>
    </div>
    <div class="card-body p-2">
      <div class="small mb-2">
        arrives in ${escapeHtml(formatNumber(option.estimatedTravelMinutes))} min ·
        covers ${escapeHtml(((option.coveredFaultProbability ?? 0) * 100).toFixed(0))}% of the fault distribution
      </div>
      <table class="table table-sm mb-0">
        <thead><tr><th>term</th><th class="text-end">value</th><th class="text-end">weighted</th><th></th></tr></thead>
        <tbody>${terms || '<tr><td colspan="4" class="text-muted">no breakdown recorded</td></tr>'}</tbody>
      </table>
      <div class="text-end mt-1">total <strong>${escapeHtml(formatNumber(total))}</strong></div>
    </div>`;
  return box;
}

function rejectedTable(rejected) {
  const table = document.createElement('table');
  table.className = 'table table-sm mb-0';

  if (rejected.length === 0) {
    table.innerHTML = '<tbody><tr><td class="text-muted">nothing was rejected</td></tr></tbody>';
    return table;
  }

  // Grouped by reason code so the shape of the rejection is visible at a
  // glance — twenty CAPABILITY_MISSING and one SLA_UNREACHABLE is a different
  // story from the reverse, and an ungrouped list of twenty-one rows tells
  // neither.
  const byCode = new Map();
  for (const option of rejected) {
    const code = option.rejectionCode ?? 'UNKNOWN';
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(option);
  }

  const groups = [...byCode.entries()].sort((a, b) => b[1].length - a[1].length);
  table.innerHTML =
    '<thead><tr><th>reason</th><th>units</th><th>detail</th></tr></thead><tbody>' +
    groups
      .map(
        ([code, options]) => `
        <tr>
          <td><span class="reason-code">${escapeHtml(code)}</span> <span class="text-muted">×${options.length}</span></td>
          <td class="mono">${escapeHtml(options.slice(0, 4).map((option) => option.unitId).join(' '))}${
            options.length > 4 ? ` +${options.length - 4}` : ''
          }</td>
          <td class="text-muted small">${escapeHtml(options[0].rejectionDetail ?? '')}</td>
        </tr>`,
      )
      .join('') +
    '</tbody>';
  return table;
}

function sectionTitle(text) {
  const title = document.createElement('div');
  title.className = 'text-muted small mt-3 mb-1';
  title.textContent = text;
  return title;
}

function hint(text) {
  const box = document.createElement('div');
  box.className = 'text-muted small';
  box.textContent = text;
  return box;
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return Math.abs(number) >= 100 ? number.toFixed(0) : number.toFixed(1);
}

// Every value below comes from the database, and a rejection detail is a
// server-built string — but it is still interpolated into innerHTML, so it is
// escaped. A capability code or a unit id is not a place to discover that
// something upstream accepted a `<`.
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
