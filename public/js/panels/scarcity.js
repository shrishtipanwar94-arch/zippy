// CAPABILITY SCARCITY — the coupled constraint, made visible.
//
// The number this panel leads with is CREWED PAIRS, not units and not
// technicians. Two EV certifications and two EV vans is only two dispatchable
// EV crews if the certified technicians are sitting in those vans; if they are
// not, the fleet has zero and both component counts still read two. The pair
// count is the one an operator can plan against, and the two halves are shown
// beside it to explain how the pair count got there.
//
// Colour is never the only signal (docs/UI.md): every row carries its level as
// a word as well as a colour, so the panel is readable in greyscale and to
// someone who cannot distinguish amber from red.
//
// Rebuilt wholesale. There are a dozen rows, they change only when the fleet
// changes, and there is no scroll position or input state to lose.

const LEVEL_LABEL = { red: 'CRITICAL', amber: 'THIN', ok: 'ok' };
const LEVEL_COLOUR = { red: 'var(--danger)', amber: 'var(--accent)', ok: 'var(--text-muted)' };

export function render(state) {
  const panel = document.querySelector('[data-panel="scarcity"]');
  if (!panel) return;

  const rows = state.scarcity.capabilities;
  if (rows.length === 0) {
    panel.replaceChildren(hint('No capability data loaded.'));
    return;
  }

  const table = document.createElement('table');
  table.className = 'table table-sm mb-0';
  table.innerHTML =
    '<thead><tr>' +
    '<th>capability</th>' +
    '<th class="text-end">crews</th>' +
    '<th class="text-end">units</th>' +
    '<th class="text-end">techs</th>' +
    '<th></th>' +
    '</tr></thead><tbody>' +
    rows.map((row) => renderRow(row, state.scarcity)).join('') +
    '</tbody>';

  const summary = document.createElement('div');
  summary.className = 'text-muted small mt-1';
  summary.textContent =
    `${state.scarcity.totalCrewedUnits} crewed unit(s), ` +
    `${state.scarcity.totalTechnicians} active technician(s)`;

  panel.replaceChildren(table, summary);
}

function renderRow(row, totals) {
  const colour = LEVEL_COLOUR[row.level];
  return `
    <tr>
      <td class="mono">${escapeHtml(row.code)}</td>
      <td class="text-end" style="color:${colour}">
        <strong>${row.crewedPairs}</strong>/${totals.totalCrewedUnits}
      </td>
      <td class="text-end text-muted">${row.unitsWithCapability}</td>
      <td class="text-end text-muted">${row.techniciansWithCapability}/${row.totalTechnicians}</td>
      <td style="color:${colour}">${escapeHtml(LEVEL_LABEL[row.level])}</td>
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
