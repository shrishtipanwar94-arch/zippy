// THE STATUS LADDER, THE DIAGNOSIS FORM, AND THE COMPLETION CODE.
//
// One card for the job in hand, with exactly one primary button on it at a
// time — the next rung. The rung comes from the SERVER (`nextStep` on
// /technician/work), not from a copy of the ladder held here: the ladder is
// domain/jobLadder.ts and a second definition in the browser is a second thing
// to keep in step.
//
// Every button here enqueues. None of them calls the API. That is the design
// (see /js/offlineQueue.js): the online case is the queue draining
// immediately, so the offline path is exercised on every tap rather than only
// when the signal happens to drop.
//
// The DIAGNOSIS form is the exception and is disabled offline, deliberately.
// Filing a new diagnosis triggers a re-solve on the server (Phase 13), and
// replaying that from a queue would raise a second reassignment recommendation
// for a decision a dispatcher may already have taken. It needs a live
// connection, and the page says so rather than queueing something it cannot
// make safe.

// What each rung says on the button. The KEYS come from the server; only the
// wording is ours.
const BUTTON_LABEL = {
  EN_ROUTE: 'I am on my way',
  ARRIVED: 'I have arrived',
  DIAGNOSING: 'Start diagnosing',
  WORKING: 'Start work',
  COMPLETE: 'Finish job',
};

const STATUS_LABEL = {
  COMMITTED: 'Assigned to you',
  EN_ROUTE: 'On the way',
  ON_SITE: 'On scene',
  DIAGNOSING: 'Diagnosing',
  WORKING: 'Working',
  AWAITING_APPROVAL: 'Waiting on the driver',
};

export function render(state) {
  const panel = document.querySelector('[data-panel="ladder"]');
  if (!panel) return;

  const job = state.work.jobs.find((candidate) => candidate.jobId === state.activeJobId)
    ?? state.work.jobs[0];

  const markup = `
    <div data-panel="ladder" class="mb-4">
      ${job ? jobMarkup(job, state) : '<p class="text-muted">No job in hand.</p>'}
    </div>`;

  // eslint-disable-next-line no-undef
  morphdom(panel, markup);
}

function jobMarkup(job, state) {
  const offline = !state.outbox.online;

  return `
    <div class="card job-card" data-job-id="${escapeText(job.jobId)}">
      <div class="card-body">
        <p class="h5 mb-1">${escapeText(job.vehicle)}</p>
        <p class="small mb-2">
          ${escapeText(job.zone)}${job.landmark ? ` · ${escapeText(job.landmark)}` : ''}
        </p>
        <p class="mb-3">
          <span class="badge bg-secondary">${escapeText(STATUS_LABEL[job.status] ?? job.status)}</span>
        </p>

        ${nextActionMarkup(job)}

        <hr />
        <p class="small mb-1">Found something different?</p>
        <select class="form-select mb-2" data-field="diagnosis-complaint" ${offline ? 'disabled' : ''}>
          <option value="WONT_START">Will not start</option>
          <option value="FLAT_TYRE">Flat tyre</option>
          <option value="LOCKED_OUT">Locked out</option>
          <option value="WARNING_LIGHT">Warning light</option>
          <option value="NOISE_OR_SMELL">Noise or smell</option>
          <option value="STUCK_OR_DAMAGED">Stuck or damaged</option>
        </select>
        <button class="btn btn-outline-warning w-100 mb-2" data-diagnose="${escapeText(job.jobId)}" ${offline ? 'disabled' : ''}>
          File a new diagnosis
        </button>
        <!-- Online only, like the diagnosis: pricing reads the job's pinned
             price list and its current diagnosis, neither of which the phone
             holds, and a queued estimate would be priced against a fault the
             driver has already been quoted for. -->
        <button class="btn btn-outline-info w-100" data-estimate="${escapeText(job.jobId)}" ${offline ? 'disabled' : ''}>
          Send the driver a cost
        </button>
        ${
          offline
            ? '<p class="small mt-2 mb-0">A new diagnosis re-plans the job, so it needs a live connection. Reconnect first.</p>'
            : ''
        }
      </div>
    </div>`;
}

// WHAT THE TECHNICIAN CAN DO NEXT. Three cases, and the middle one is the
// point of Phase 15c stage 2: a job waiting on a driver's decision has NO next
// rung — `nextStepFor` returns null for AWAITING_APPROVAL because the ladder
// has no rank for it — so the card says who it is waiting on rather than
// offering a button that the server would refuse.
function nextActionMarkup(job) {
  if (job.status === 'AWAITING_APPROVAL') {
    return `
      <div class="alert alert-warning py-2 px-3 mb-0">
        Work is paused until the driver approves the cost. You will see this
        card change when they answer.
      </div>`;
  }
  if (job.nextStep === 'COMPLETE') return completionMarkup(job);
  return ladderButtonMarkup(job);
}

function ladderButtonMarkup(job) {
  if (!job.nextStep) return '<p class="mb-0">Nothing left to do on this job.</p>';
  return `
    <button class="btn btn-primary btn-lg w-100" data-step="${escapeText(job.nextStep)}" data-job-id="${escapeText(job.jobId)}">
      ${escapeText(BUTTON_LABEL[job.nextStep] ?? job.nextStep)}
    </button>`;
}

// The last rung is not a button on its own — it is the driver's code. Entering
// it is what closes the job, and from Phase 15c it is also what releases the
// payment capture, which is why nothing else can stand in for it.
function completionMarkup(job) {
  return `
    <label class="form-label" for="completion-code">
      Ask the driver for the code on their screen
    </label>
    <input id="completion-code" class="form-control form-control-lg mb-2"
           inputmode="numeric" autocomplete="off" placeholder="000 000" />
    <button class="btn btn-success btn-lg w-100" data-step="COMPLETE" data-job-id="${escapeText(job.jobId)}">
      ${escapeText(BUTTON_LABEL.COMPLETE)}
    </button>`;
}

// WHAT THE QUEUE IS HOLDING, and what came back. Both on screen: a tap that
// went into a queue and a tap that was refused look identical to a technician
// otherwise, and only one of them means "do it again".
export function renderOutbox(state) {
  const banner = document.querySelector('[data-field="outbox"]');
  if (banner) {
    const count = state.outbox.pending.length;
    const text =
      count === 0
        ? ''
        : `${count} ${count === 1 ? 'action is' : 'actions are'} waiting to send. They will go in order as soon as you are back online.`;
    if (banner.textContent !== text) banner.textContent = text;
    banner.hidden = count === 0;
  }

  const network = document.querySelector('[data-field="network"]');
  if (network) {
    const text = state.outbox.online ? 'online' : 'offline';
    if (network.textContent !== text) network.textContent = text;
    const className = `badge ${state.outbox.online ? 'bg-success' : 'bg-danger'}`;
    if (network.className !== className) network.className = className;
  }

  const results = document.querySelector('[data-field="outbox-results"]');
  if (!results) return;
  const markup = `
    <ul class="list-unstyled small" data-field="outbox-results">
      ${state.outbox.results.map(resultMarkup).join('')}
    </ul>`;
  // eslint-disable-next-line no-undef
  morphdom(results, markup);
}

function resultMarkup(result) {
  return `<li>${escapeText(BUTTON_LABEL[result.step] ?? result.step)} — ${escapeText(result.detail ?? result.outcome)}</li>`;
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
