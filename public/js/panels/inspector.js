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

import { narrateDecision } from './decisionNarration.js';

export function render(state) {
  const panel = document.querySelector('[data-panel="inspector"]');
  if (!panel) return;

  // WHETHER THIS COLUMN IS WORTH ITS WIDTH. Keyed off `jobId` rather than
  // `decision` on purpose: the id is set the moment a row is clicked and the
  // decision arrives a request later, so keying off the decision would leave
  // the column collapsed for the whole round trip and then pop it open — the
  // click would look like it had failed. See console-regions.css.
  const grid = document.querySelector('.console-grid');
  if (grid) grid.classList.toggle('no-selection', !state.inspector.jobId);

  const decision = state.inspector.decision;
  if (!decision) {
    // RULE ONE OF THE READABILITY PASS: one line, not six empty cards. This
    // column is about a single job and says so until there is one.
    panel.replaceChildren(
      hint('Pick a job from the priority queue to see why its crew was chosen, what was rejected, and where a tow would go.'),
    );
    return;
  }

  const parts = [header(decision)];

  if (!decision.solverRun) {
    parts.push(hint('No solver run has considered this job yet.'));
    panel.replaceChildren(...parts);
    return;
  }

  parts.push(runSummary(decision.solverRun));

  // THE DECISION IN WORDS, ABOVE THE ARITHMETIC. Everything below this is the
  // same decision expressed as numbers; this is it expressed as the sentence a
  // dispatcher would say to a customer. It computes nothing — see
  // panels/decisionNarration.js.
  const narration = narrateDecision(decision);
  if (narration) parts.push(narrationBlock(narration));

  if (decision.hypothesis) parts.push(hypothesisBlock(decision.hypothesis));

  // Per job, not per option — and above the options, because when screening
  // found nowhere to tow to it is the reason every option below was rejected.
  const screening = destinationScreeningPanel(destinationFor(decision));
  if (screening) parts.push(screening);

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

function runSummary(run) {
  const box = document.createElement('div');
  box.className = 'small text-muted mb-2';
  box.innerHTML =
    `solver run <span class="mono">${escapeHtml(run.id.slice(-8))}</span> · ` +
    `trigger <span class="mono">${escapeHtml(run.trigger)}</span> · ` +
    `${run.optionCount} options, ${run.feasibleCount} feasible · ${run.wallClockMs}ms` +
    (run.zonePartitioned ? ' · ZONE-PARTITIONED' : '');
  return box;
}

// THE DECISION AS PROSE. One heading, a paragraph per thing worth saying, and —
// when a human departed from the recommendation — their reason in amber.
//
// AMBER FOR THE OVERRIDE, and this is the one question the cost breakdown below
// genuinely cannot answer. The server refuses to record a non-BALANCED plan
// without a reason (422 from POST /plans/:id/select) and stores it on
// decision_records.override_reason_code. Until Phase 22b's audit this panel read
// `decision.decisionRecordNote`, a key GET /jobs/:id/decision has never sent —
// so the justification was demanded, stored, and then shown to nobody.
//
// textContent throughout rather than innerHTML: every sentence here is built in
// the browser out of server data, and a rejection detail or an override reason
// is not a place to discover that something upstream accepted a `<`.
function narrationBlock(narration) {
  const box = document.createElement('div');
  box.className = 'decision-story mb-3';

  const heading = document.createElement('div');
  heading.className = 'decision-story-title';
  heading.textContent = narration.title;
  box.append(heading);

  for (const paragraph of narration.paragraphs) {
    const line = document.createElement('p');
    line.className = 'mb-1';
    line.textContent = paragraph;
    box.append(line);
  }

  if (narration.override) {
    const note = document.createElement('div');
    note.className = 'override-note small mt-2';
    note.textContent = narration.override;
    box.append(note);
  }

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

// WHERE THE PART IS COMING FROM, when it is not already in the van. A dispatch
// that quietly sends a crew across town to a depot first is a dispatch an
// operator has to be able to see, or the arrival time on the card looks like a
// mistake rather than a decision (invariant 8).
function partSourcingLine(sourcing) {
  if (!sourcing || sourcing.status !== 'WORKSHOP_RUN') return '';

  const skus = (sourcing.missingSkus ?? []).join(', ');
  return `
    <div class="small mb-2 text-warning-emphasis">
      collecting ${escapeHtml(skus)} on the way —
      ${escapeHtml(formatNumber(sourcing.detourMinutes))} min detour
    </div>`;
}

// THE DESTINATION SCREENING PANEL (Phase 22) — every active workshop and what
// became of it.
//
// TWO THINGS THIS PANEL GOT WRONG UNTIL PHASE 22b'S AUDIT, and they compounded.
// It rendered only when `status === 'CHOSEN'`, and the list it rendered was the
// priced shortlist — every row of which had already cleared brand, EV class and
// opening hours. So a ✕ meant "not the cheapest", the workshop excluded because
// it does not touch this brand appeared nowhere, and the whole panel vanished
// in exactly the case it exists to explain: a tow with nowhere to tow to.
//
// It is also rendered PER JOB rather than inside the chosen option's card, and
// that is not cosmetic. A destination is a property of the job — one workshop
// choice, carried identically by every option (see the header of
// src/engine/destinationSelection.ts) — so hanging it off the winning option
// meant that when nothing won, nothing showed.

// The exclusion codes, in words. The code is shown too: an operator who has
// seen EV_CLASS_MISMATCH twice this week knows something the sentence does not
// tell them — the same argument the escalation card makes for its own codes.
const EXCLUSION_WORDS = {
  BRAND_NOT_AUTHORISED: 'not authorised for this brand',
  EV_CLASS_MISMATCH: 'authorised for the brand, not equipped for this EV class',
  CLOSED_NOW: 'closed at this hour',
  NOT_SHORTLISTED: 'cleared screening, further than the four priced',
};

// What the job-level heading says when no workshop was chosen. Keyed on the
// destination status the engine recorded, so the panel and the feasibility
// reason code cannot tell different stories.
const DESTINATION_STATUS_WORDS = {
  NO_BRAND_MATCH: 'no active workshop is authorised for this brand',
  NO_EV_CLASS_MATCH: 'authorised workshops exist, none equipped for this EV class',
  NO_DESTINATION_REACHABLE: 'authorised and equipped workshops exist, none open at this hour',
};

// The destination is one decision for the whole job, so it is read from
// whichever option happens to carry it — chosen first, then any rejected one.
// A rejected option is the ONLY place it exists when screening found nothing.
function destinationFor(decision) {
  const options = [...(decision.chosen ?? []), ...(decision.rejected ?? [])];
  for (const option of options) {
    if (option.destination?.screened?.length) return option.destination;
  }
  return null;
}

function destinationScreeningPanel(destination) {
  if (!destination?.screened?.length) return null;

  const box = document.createElement('div');
  box.className = 'mb-2';

  const status = DESTINATION_STATUS_WORDS[destination.status];
  const heading = status
    ? `<div class="small text-danger">destination screening — ${escapeHtml(status)}</div>`
    : '<div class="small text-muted">destination screening</div>';

  box.innerHTML = heading + [...destination.screened].sort(screeningOrder).map(screeningRow).join('');
  return box;
}

// Chosen first, then everything still eligible by distance, then the excluded
// grouped by which screen they failed — the pipeline's own order, so the list
// reads top to bottom the way the decision was made.
function screeningOrder(a, b) {
  if (a.chosen !== b.chosen) return a.chosen ? -1 : 1;
  const rank = (row) => (row.excludedBy ? EXCLUSION_ORDER.indexOf(row.excludedBy) + 1 : 0);
  const byStage = rank(a) - rank(b);
  if (byStage !== 0) return byStage;
  return (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
}

const EXCLUSION_ORDER = [
  'NOT_SHORTLISTED',
  'CLOSED_NOW',
  'EV_CLASS_MISMATCH',
  'BRAND_NOT_AUTHORISED',
];

function screeningRow(row) {
  // Three marks, not two. A workshop that cleared every screen and simply lost
  // on distance is not in the same category as one that may not touch this car,
  // and showing both as ✕ is what made the old panel unreadable.
  const mark = row.chosen
    ? '<span class="text-success">✓</span>'
    : row.excludedBy && row.excludedBy !== 'NOT_SHORTLISTED'
      ? '<span class="text-danger">✕</span>'
      : '<span class="text-muted">○</span>';

  // Rows written before this panel existed carry neither a name nor a reason;
  // the id is the honest fallback rather than a blank.
  const name = row.name ?? row.workshopId;
  const priced =
    typeof row.pAccept === 'number' && typeof row.distanceKm === 'number'
      ? ` <span class="text-muted">P(accept) ${row.pAccept.toFixed(2)} · ${row.distanceKm.toFixed(1)} km</span>`
      : '';
  const why = row.excludedBy
    ? ` <span class="reason-code">${escapeHtml(row.excludedBy)}</span>
        <span class="text-muted">${escapeHtml(EXCLUSION_WORDS[row.excludedBy] ?? '')}</span>`
    : '';

  return `<div class="small">${mark} ${escapeHtml(name)}${priced}${why}</div>`;
}

// THE COST TERMS, IN OPERATOR VOCABULARY.
//
// These rows used to print the solver's own property names — `slaRisk`,
// `partSourcingCost`, `contractSlaExposure`. An ENUM on this console is
// correct: CAPABILITY_MISSING and NO_TECHNICIAN_ON_SHIFT are the words the
// system and the operator genuinely share, and softening them would lose
// precision. A camelCase VARIABLE NAME is not the same thing — it is an
// implementation detail that leaked into a table a dispatcher has to read
// under time pressure, and "SLA risk" is the same width.
//
// A term with no entry here still renders, as its raw key. A missing label
// should look slightly wrong rather than hide a term that is moving the total.
const TERM_LABELS = {
  slaRisk: 'SLA risk',
  travelDistance: 'Travel distance',
  travelTime: 'Travel time',
  operationalCost: 'Operational cost',
  partSourcingCost: 'Part sourcing',
  contractSlaExposure: 'Contract exposure',
  destinationRefusalRisk: 'Workshop refusal risk',
  capabilityShortfallRisk: 'Capability shortfall',
  expectedTimeToResolution: 'Time to resolution',
};

// MONEY IN RUPEES, NOT PAISE. `20901 paise` is a number nobody converts in
// their head while comparing two crews, and the money column was the only one
// on the console still in the storage unit.
//
// A NEGATIVE EXPOSURE IS A CREDIT, and saying so is the point. Contract
// exposure is negative when the assignment protects a contract rather than
// risking one, so the figure that reads as a broken minus sign is actually the
// best news in the table.
function formatTermValue(term) {
  const value = Number(term.value);
  if (term.unit !== 'paise' || !Number.isFinite(value)) {
    return { text: formatNumber(term.value), unit: term.unit ?? '' };
  }

  const rupees = Math.round(Math.abs(value) / 100).toLocaleString('en-IN');
  if (value < 0) return { text: `₹${rupees}`, unit: 'credit' };
  return { text: `₹${rupees}`, unit: '' };
}

// The cost breakdown, term by term. Each term carries its own unit because
// they are not commensurable — minutes, kilometres, two probabilities and
// money — and the weights are what convert them, so showing a bare number per
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
      const shown = formatTermValue(term);
      return `
        <tr>
          <td>${escapeHtml(TERM_LABELS[key] ?? key)}</td>
          <td class="text-end mono">${escapeHtml(shown.text)} <span class="text-muted">${escapeHtml(shown.unit)}</span></td>
          <td class="text-end mono">${escapeHtml(formatNumber(contribution))}</td>
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
      ${partSourcingLine(option.partSourcing)}
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
