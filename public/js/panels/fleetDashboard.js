// THE FLEET MANAGER'S DASHBOARD — the numbers the phase brief names, and
// nothing else. No export button, no chart, no report beyond what is on this
// page: that restriction is deliberate (BUILD_PHASES.md's own DO NOT for this
// phase), not an oversight to fill in later.
//
// EVERY NUMBER ON THIS PANEL IS ALREADY COMPUTED. GET /fleet/dashboard
// (src/api/fleet.ts) does every calculation server-side; this file only
// arranges what came back. The same rule the driver's screen follows for
// status sentences applies here to money and percentages: one place computes
// them, so a fleet manager's dashboard and an operator's report can never
// quietly disagree about what "SLA met" means this month.
//
// Rebuilt wholesale on refresh — this is a summary a person checks, not a
// live feed, so there is no partial-update case to get right.

export function render(state) {
  const panel = document.querySelector('[data-panel="fleet-dashboard"]');
  if (!panel) return;

  const dashboard = state.fleetDashboard;
  if (!dashboard) {
    panel.replaceChildren(hint('Loading your fleet…'));
    return;
  }

  panel.replaceChildren(
    summaryRow(dashboard),
    activeIncidentsCard(dashboard),
    vehiclesCard(dashboard),
  );
}

// FIVE TILES, AND THE COUNT PER ROW STEPS DOWN WITH THE WIDTH — five across on
// a desktop, then three, then two, then one on a phone. `.metric-grid` owns
// that (console.css); five tiles do not divide into Bootstrap's twelve columns
// and its breakpoints are not this project's.
function summaryRow(dashboard) {
  const row = document.createElement('div');
  row.className = 'metric-grid mb-3';
  row.innerHTML = [
    statTile('Active incidents', String(dashboard.activeIncidents.length)),
    statTile(
      'SLA met this month',
      dashboard.slaMetPercent === null ? '—' : `${dashboard.slaMetPercent}%`,
      dashboard.slaDecidedCount === 0
        ? 'no decided incidents yet'
        : `${dashboard.slaDecidedCount} decided incident(s)`,
    ),
    statTile(
      'Current exposure',
      dashboard.currentExposureRupees,
      'contract breaches still open, at today’s penalty',
    ),
    statTile(
      'Mean resolution time',
      dashboard.meanResolutionMinutes === null ? '—' : `${dashboard.meanResolutionMinutes} min`,
      dashboard.resolvedCount === 0 ? 'nothing resolved yet this month' : `${dashboard.resolvedCount} resolved`,
    ),
    statTile('Spend this month', dashboard.spendRupees),
  ].join('');
  return row;
}

function statTile(label, value, note) {
  return `
    <div class="metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)}</div>
      ${note ? `<div class="metric-note">${escapeHtml(note)}</div>` : ''}
    </div>`;
}

function activeIncidentsCard(dashboard) {
  const card = document.createElement('div');
  card.className = 'card mb-3';

  // EVERY CELL CARRIES ITS COLUMN NAME. Below 640 the header row is hidden and
  // each row becomes a card, with `data-label` supplying the label beside each
  // value — see `.stack-table` in console.css. The registration is the card's
  // heading rather than one of its fields, which is what `is-heading` marks.
  const rows = dashboard.activeIncidents
    .map(
      (incident) => `
        <tr>
          <td class="mono is-heading" data-label="vehicle">${escapeHtml(incident.registration)}</td>
          <td data-label="status">${escapeHtml(incident.status)}</td>
          <td data-label="safety">${escapeHtml(incident.safetyLevel)}</td>
          <td data-label="believed fault">${escapeHtml(incident.topFault ?? '—')}</td>
          <td class="text-muted small" data-label="raised">${escapeHtml(formatWhen(incident.createdAt))}</td>
        </tr>`,
    )
    .join('');

  card.innerHTML = `
    <div class="card-header">Active incidents</div>
    <div class="card-body p-2">
      ${
        dashboard.activeIncidents.length === 0
          ? '<div class="text-muted small">Nothing active right now.</div>'
          : `<table class="table table-sm mb-0 stack-table">
               <thead><tr><th>vehicle</th><th>status</th><th>safety</th><th>believed fault</th><th>raised</th></tr></thead>
               <tbody>${rows}</tbody>
             </table>`
      }
    </div>`;
  return card;
}

function vehiclesCard(dashboard) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="card-header">Per-vehicle incident history</div>
    <div class="card-body p-2">
      ${
        dashboard.vehicles.length === 0
          ? '<div class="text-muted small">No incidents on file yet.</div>'
          : dashboard.vehicles.map(vehicleBlock).join('')
      }
    </div>`;
  return card;
}

function vehicleBlock(vehicle) {
  // THE FLAG SAYS WHAT IT IS, IN WORDS ON THE SCREEN. Phase 21's brief is
  // explicit — "It is a RULE, not a model. Label it as one in the UI" — and
  // until Phase 22b's audit the label was the bare token RULE with the
  // explanation in a `title` tooltip: invisible on a touch device, invisible to
  // a screen reader, and invisible to anyone who does not happen to hover. The
  // distinction is the whole point of the flag. A fleet manager who reads this
  // as a prediction will expect it to tell them which van breaks down next, and
  // it cannot: it counts to three.
  const flag = vehicle.repeatPatternFlag;
  const flagBadge = flag
    ? '<span class="badge bg-warning text-dark ms-2">Repeat pattern</span>'
    : '';
  const flagLine = flag
    ? `<div class="alert alert-warning py-1 px-2 my-2 small mb-2">
         <div>${escapeHtml(vehicle.registration)} — ${escapeHtml(flag.message)}</div>
         <div class="rule-note mt-1">
           This is a counting rule, not a prediction: it counts
           ${escapeHtml(String(flag.count))} incidents of the same fault in the
           window. It does not forecast future breakdowns.
         </div>
       </div>`
    : '';

  // Same stacked-card treatment as the active incidents table. The card is
  // already headed by the registration above it, so here the heading cell is
  // the date — which is what tells one row of a vehicle's history from another.
  const rows = vehicle.incidents
    .map(
      (incident) => `
        <tr>
          <td class="is-heading" data-label="raised">${escapeHtml(formatWhen(incident.createdAt))}</td>
          <td data-label="status">${escapeHtml(incident.status)}</td>
          <td data-label="believed fault">${escapeHtml(incident.topFault ?? '—')}</td>
          <td data-label="SLA">${escapeHtml(SLA_OUTCOME_LABEL[incident.slaOutcome] ?? incident.slaOutcome)}</td>
        </tr>`,
    )
    .join('');

  return `
    <div class="mb-3">
      <div class="fw-semibold">
        ${escapeHtml(vehicle.registration)}
        <span class="text-muted small">${escapeHtml(vehicle.make)} ${escapeHtml(vehicle.model)}</span>
        ${flagBadge}
      </div>
      ${flagLine}
      <table class="table table-sm mb-0 stack-table">
        <thead><tr><th>raised</th><th>status</th><th>believed fault</th><th>SLA</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

const SLA_OUTCOME_LABEL = {
  MET: 'met',
  BREACHED: 'breached',
  UNDECIDED: 'in window',
  NOT_APPLICABLE: '—',
};

// A clock time, not a relative one — the same choice driverNarrative.ts makes
// for the driver's screen, for the same reason: "3 hours ago" goes stale the
// moment the tab is left open.
function formatWhen(iso) {
  return new Date(iso).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
