// THE DISPATCH BOARD. The one panel that genuinely has to patch rather than
// rebuild.
//
// Jobs arrive every few seconds once the simulator is running. Rewriting the
// table's innerHTML on every event would reset scroll position and drop the
// operator's selection mid-sentence — during a demo it reads as the page
// crashing and reloading. So a row is found by its data-job-id and its cells
// are updated in place; only genuinely new jobs create an element, and only
// jobs that have gone remove one.
//
// data-job-id is also what makes the row addressable from anywhere else that
// needs it, and it is what the Phase 4 check counts.

const SAFETY_CLASS = {
  HIGH_RISK: 'table-danger',
  ELEVATED: 'table-warning',
  NORMAL: '',
};

function unitLabel(state, unitId) {
  const unit = state.units.find((candidate) => candidate.id === unitId);
  return unit ? unit.code : unitId.slice(-8);
}

function cellValues(state, job) {
  const events = state.events[job.id] ?? [];
  const latest = events[events.length - 1];
  return {
    id: job.id.slice(-8),
    status: job.status ?? '—',
    safety: job.safetyLevel ?? '—',
    events: String(events.length),
    latest: latest ? latest.eventType : '—',
    unit: job.assignedUnitId ? unitLabel(state, job.assignedUnitId) : '—',
  };
}

const TEXT_FIELDS = ['id', 'status', 'safety', 'events', 'latest', 'unit'];

function buildRow(jobId, hasAssignControl) {
  const row = document.createElement('tr');
  row.dataset.jobId = jobId;
  for (const field of TEXT_FIELDS) {
    const cell = document.createElement('td');
    cell.dataset.field = field;
    row.appendChild(cell);
  }

  if (hasAssignControl) {
    // Built once, when the row is created. The select is never rebuilt on a
    // later render — replacing it would discard whatever the dispatcher had
    // chosen but not yet submitted, which on a board taking a job every few
    // seconds means the dropdown resets under their cursor.
    const cell = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'form-select form-select-sm';
    select.dataset.field = 'unit-select';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm btn-outline-primary mt-1';
    button.dataset.action = 'assign';
    button.textContent = 'Assign';

    cell.append(select, button);
    row.appendChild(cell);
  }

  return row;
}

// Options change only when the unit list loads or a unit's status moves, so
// they are stamped with what they were built from and left alone otherwise.
function fillUnitOptions(select, units) {
  const available = units.filter((unit) => unit.status === 'AVAILABLE');
  const signature = available.map((unit) => unit.id).join(',');
  if (select.dataset.units === signature) return;

  select.dataset.units = signature;
  select.replaceChildren();
  for (const unit of available) {
    const option = document.createElement('option');
    option.value = unit.id;
    option.textContent = `${unit.code} (${unit.kind})`;
    select.appendChild(option);
  }
}

export function render(state) {
  const table = document.querySelector('[data-panel="jobs-table"]');
  const body = table?.querySelector('tbody');
  if (!body) return;

  // Only the dispatcher board carries the assignment column; the technician
  // table uses the same panel without it.
  const canAssign = table.dataset.assign === 'true';
  const seen = new Set();

  for (const jobId of state.jobOrder) {
    const job = state.jobs[jobId];
    if (!job) continue;
    seen.add(jobId);

    let row = body.querySelector(`tr[data-job-id="${jobId}"]`);
    if (!row) {
      row = buildRow(jobId, canAssign);
      // Newest first, matching jobOrder.
      body.prepend(row);
    }

    const select = row.querySelector('[data-field="unit-select"]');
    if (select) fillUnitOptions(select, state.units);

    const values = cellValues(state, job);
    for (const [field, value] of Object.entries(values)) {
      const cell = row.querySelector(`td[data-field="${field}"]`);
      // Only write when it actually differs — an assignment to textContent is
      // a DOM mutation even when the text is identical, and it is what makes a
      // selection flicker.
      if (cell && cell.textContent !== value) cell.textContent = value;
    }

    const safetyClass = SAFETY_CLASS[job.safetyLevel] ?? '';
    if (row.className !== safetyClass) row.className = safetyClass;
  }

  for (const row of [...body.querySelectorAll('tr[data-job-id]')]) {
    if (!seen.has(row.dataset.jobId)) row.remove();
  }

  const count = document.querySelector('[data-field="job-count"]');
  if (count) count.textContent = String(seen.size);
}
