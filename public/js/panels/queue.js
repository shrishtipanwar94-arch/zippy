// THE PRIORITY QUEUE — which job a dispatcher should look at next.
//
// The order comes from the server (src/domain/priority.ts) and this panel does
// not re-sort it. That is deliberate: the ordering rule is invariant 4, and an
// invariant implemented in two places is an invariant implemented in neither.
// If the browser sorted, a bug in either copy would silently produce a
// different queue in the console from the one the rest of the system believes
// in.
//
// WHAT THE PANEL DOES ADD is the three sort keys, shown per row. A queue that
// only shows an order asks to be trusted; a queue that shows safety, SLA
// consumption and age next to each job can be checked. That matters most
// exactly when it looks wrong — an operator who can see that a NORMAL job sits
// above an ELEVATED one knows immediately that something is broken, rather
// than assuming the machine knows best.

const SAFETY_CLASS = {
  HIGH_RISK: 'safety-HIGH_RISK',
  ELEVATED: 'safety-ELEVATED',
  NORMAL: '',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="queue"]');
  if (!panel) return;

  const jobs = state.queue.jobs;
  if (jobs.length === 0) {
    panel.replaceChildren(hint('Nothing waiting.'));
    return;
  }

  const table = document.createElement('table');
  table.className = 'table table-sm mb-0';
  table.innerHTML =
    '<thead><tr>' +
    '<th>#</th><th>job</th><th>zone</th><th>safety</th>' +
    '<th class="text-end">SLA used</th><th class="text-end">age</th>' +
    '</tr></thead><tbody>' +
    jobs.map((job, index) => renderRow(job, index)).join('') +
    '</tbody>';

  panel.replaceChildren(table);
}

function renderRow(job, index) {
  // Over 100% means the window has already closed. Shown as a number rather
  // than clamped, because "300% over" and "105% over" are different problems
  // and a dispatcher working a backlog needs to tell them apart.
  const slaText =
    job.slaResponseMinutes === null
      ? '<span class="text-muted">no SLA</span>'
      : `${(job.slaRisk * 100).toFixed(0)}%`;
  const slaColour = job.slaRisk >= 1 ? 'var(--danger)' : job.slaRisk >= 0.75 ? 'var(--accent)' : '';

  return `
    <tr>
      <td class="text-muted">${index + 1}</td>
      <td>
        <button type="button" class="btn btn-link btn-sm p-0 mono" data-action="inspect"
          data-job-id="${escapeHtml(job.id)}">${escapeHtml(job.id.slice(-8))}</button>
      </td>
      <td class="mono text-muted">${escapeHtml(job.zoneId)}</td>
      <td class="${SAFETY_CLASS[job.safetyLevel] ?? ''}">${escapeHtml(job.safetyLevel)}</td>
      <td class="text-end" style="color:${slaColour}">${slaText}</td>
      <td class="text-end text-muted">${job.ageMinutes}m</td>
    </tr>`;
}

function hint(text) {
  const box = document.createElement('div');
  box.className = 'text-muted small';
  box.textContent = text;
  return box;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
