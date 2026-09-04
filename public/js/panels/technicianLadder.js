// THE JOB IN HAND — the rung track, the pause, the money, and the detour.
//
// One card, with exactly one primary button on it at a time: the next rung. The
// rung comes from the SERVER (`nextStep` on /technician/work), not from a copy
// of the ladder held here — the ladder is domain/jobLadder.ts and a second
// definition in the browser is a second thing to keep in step.
//
// Every button here enqueues. None of them calls the API. That is the design
// (see /js/offlineQueue.js): the online case is the queue draining immediately,
// so the offline path is exercised on every tap rather than only when the
// signal happens to drop.
//
// The DIAGNOSIS form is the exception and is disabled offline, deliberately.
// Filing a new diagnosis triggers a re-solve on the server (Phase 13), and
// replaying that from a queue would raise a second reassignment recommendation
// for a decision a dispatcher may already have taken.
//
// WHAT PHASE 22b'S AUDIT ADDED HERE:
//   - a RUNG TRACK, so "where am I in this job" is one glance rather than a
//     status badge that has to be read and decoded
//   - the ESTIMATE the driver is deciding on, itemised, and the amount the
//     AWAITING_APPROVAL pause is waiting for. The pause was already worded; it
//     did not say what the money was.
//   - the PART SOURCING detour (Phase 19) and the WORKSHOP a tow is going to
//     (Phase 22), neither of which the technician could see at all
//   - what entering the completion code actually DOES. It releases the payment
//     capture, which was documented in a code comment and nowhere on screen.

const BUTTON_LABEL = {
  EN_ROUTE: 'I am on my way',
  ARRIVED: 'I have arrived',
  DIAGNOSING: 'Start diagnosing',
  WORKING: 'Start work',
  COMPLETE: 'Finish job',
  // Not a rung. A parts declaration shares the offline queue with the ladder,
  // so its answer comes back through the same results list and needs a word.
  PARTS: 'Parts fitted',
};

const STATUS_LABEL = {
  COMMITTED: 'Assigned to you',
  EN_ROUTE: 'On the way',
  ON_SITE: 'On scene',
  DIAGNOSING: 'Diagnosing',
  WORKING: 'Working',
  AWAITING_APPROVAL: 'Waiting on the driver',
};

// THE TRACK, in the order a job is actually worked. AWAITING_APPROVAL is
// deliberately absent: it is not a rung, it is a job stopped between two of
// them, which is why `nextStepFor` returns null for it on the server.
const RUNGS = [
  { status: 'COMMITTED', label: 'Assigned' },
  { status: 'EN_ROUTE', label: 'On the way' },
  { status: 'ON_SITE', label: 'On scene' },
  { status: 'DIAGNOSING', label: 'Diagnosing' },
  { status: 'WORKING', label: 'Working' },
];

export function render(state) {
  const panel = document.querySelector('[data-panel="ladder"]');
  if (!panel) return;

  const job = state.work.jobs.find((candidate) => candidate.jobId === state.activeJobId)
    ?? state.work.jobs[0];

  const markup = `
    <div data-panel="ladder" class="mb-4" aria-live="polite">
      ${job ? jobMarkup(job, state) : '<p class="text-secondary">No job in hand.</p>'}
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
        <p class="small text-secondary mb-3">
          ${escapeText(job.zone)}${job.landmark ? ` · ${escapeText(job.landmark)}` : ''}
        </p>

        ${rungTrackMarkup(job.status)}
        <p class="mb-3"><span class="badge text-bg-secondary">${escapeText(STATUS_LABEL[job.status] ?? job.status)}</span></p>

        ${contextMarkup(job)}
        ${estimateMarkup(job)}
        ${nextActionMarkup(job, state)}

        <hr />
        <p class="small mb-1">Found something different?</p>
        <label class="sr-only" for="diagnosis-complaint">What you found</label>
        <select id="diagnosis-complaint" class="form-select mb-2" data-field="diagnosis-complaint" ${offline ? 'disabled' : ''}>
          <option value="WONT_START">Will not start</option>
          <option value="FLAT_TYRE">Flat tyre</option>
          <option value="LOCKED_OUT">Locked out</option>
          <option value="WARNING_LIGHT">Warning light</option>
          <option value="NOISE_OR_SMELL">Noise or smell</option>
          <option value="STUCK_OR_DAMAGED">Stuck or damaged</option>
        </select>
        <button class="btn btn-outline-secondary btn-lg w-100 mb-2 tech-action" data-diagnose="${escapeText(job.jobId)}" ${offline ? 'disabled' : ''}>
          Tell us what you found
        </button>
        <!-- Online only, like the diagnosis: pricing reads the job's pinned
             price list and its current diagnosis, neither of which the phone
             holds, and a queued estimate would be priced against a fault the
             driver has already been quoted for. -->
        <button class="btn btn-outline-secondary btn-lg w-100 tech-action" data-estimate="${escapeText(job.jobId)}" ${offline ? 'disabled' : ''}>
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

// WHERE AM I IN THIS JOB, in one glance. Filled behind, amber on the current
// rung, dim ahead — and the label under it names the rung in words, because a
// track of coloured bars alone is colour as the only signal.
function rungTrackMarkup(status) {
  const index = RUNGS.findIndex((rung) => rung.status === status);
  // A paused job sits after whatever rung it reached; showing nothing filled
  // would read as "not started".
  const reached = status === 'AWAITING_APPROVAL' ? RUNGS.length - 1 : index;

  return `
    <div class="rung-track" role="img" aria-label="${escapeText(STATUS_LABEL[status] ?? status)}">
      ${RUNGS.map((rung, position) => {
        const className =
          position < reached ? 'rung is-done' : position === reached ? 'rung is-current' : 'rung';
        return `<span class="${className}"></span>`;
      }).join('')}
    </div>`;
}

// WHY THIS JOB IS NOT A STRAIGHT LINE. Two things the technician could not see
// before: a part-sourcing detour, and the workshop a tow is going to. Both are
// read exactly as the solver recorded them.
function contextMarkup(job) {
  const blocks = [];

  if (job.partSourcing && job.partSourcing.status !== 'ON_BOARD') {
    blocks.push(`
      <div class="context-card mb-3">
        <div class="context-title">Parts</div>
        <p class="mb-0">${escapeText(sourcingSentence(job.partSourcing))}</p>
      </div>`);
  }

  if (job.destination) {
    const eta = job.destination.etaSeconds
      ? ` · about ${Math.round(job.destination.etaSeconds / 60)} min away`
      : '';
    const authorised = job.destination.authorisedBrands.length > 0
      ? `Authorised for ${escapeText(job.destination.authorisedBrands.join(', '))}.`
      : 'No brand authorisation recorded for this workshop.';
    blocks.push(`
      <div class="context-card mb-3">
        <div class="context-title">Taking it to</div>
        <p class="mb-1"><strong>${escapeText(job.destination.name)}</strong>${escapeText(eta)}</p>
        <p class="small text-secondary mb-0">${authorised}</p>
      </div>`);
  }

  return blocks.join('');
}

// The driver is told "Ravi has the skills but needs a part". This is Ravi's
// side of the same sentence.
function sourcingSentence(sourcing) {
  if (sourcing.status === 'WORKSHOP_RUN') {
    return 'You do not have this part on board — the plan sends you via a workshop to collect it.';
  }
  if (sourcing.status === 'DEPOT_RUN') {
    return 'You do not have this part on board — collect it from the depot on the way.';
  }
  // IN_VAN is a database value, and it was reaching the screen whole. The
  // technician does not need the enum; they need to know whether to go and get
  // something before they start.
  if (sourcing.status === 'IN_VAN') return 'The part is in your van.';
  return sourcing.detail ?? 'We are working out where the part comes from.';
}

// WHAT THE DRIVER IS LOOKING AT. A technician standing next to somebody
// deciding whether to approve a cost should be able to see the cost.
function estimateMarkup(job) {
  const estimate = job.estimate;
  if (!estimate || estimate.lines.length === 0) return '';

  return `
    <div class="context-card mb-3">
      <div class="context-title">The cost sent to the driver</div>
      <ul class="list-unstyled small mb-2">
        ${estimate.lines
          .map(
            (line) =>
              `<li class="d-flex justify-content-between gap-2">
                 <span>${escapeText(line.description)}${line.quantity > 1 ? ` ×${escapeText(line.quantity)}` : ''}</span>
                 <span>${escapeText(rupees(line.amountPaise))}</span>
               </li>`,
          )
          .join('')}
      </ul>
      <p class="mb-0 estimate-total">
        ${
          estimate.payablePaise === 0
            ? '<strong>The driver pays nothing.</strong>'
            : `<strong>The driver pays</strong>
               <strong class="money">${escapeText(rupees(estimate.payablePaise))}</strong>`
        }
      </p>
    </div>`;
}

// WHAT THE TECHNICIAN CAN DO NEXT. Three cases, and the middle one is the point
// of Phase 15c stage 2: a job waiting on a driver's decision has NO next rung —
// `nextStepFor` returns null for AWAITING_APPROVAL — so the card says who it is
// waiting on rather than offering a button the server would refuse.
function nextActionMarkup(job, state) {
  if (job.status === 'AWAITING_APPROVAL') {
    const amount = job.estimate ? ` of ${rupees(job.estimate.payablePaise)}` : '';
    return `
      <div class="alert alert-warning mb-0">
        <strong>Paused — waiting on the driver.</strong>
        <div>They are deciding on the cost${escapeText(amount)}. Nothing you can do moves this
        forward; the card changes as soon as they answer.</div>
      </div>`;
  }
  if (job.nextStep === 'COMPLETE') return completionMarkup(job, state);
  return ladderButtonMarkup(job);
}

function ladderButtonMarkup(job) {
  if (!job.nextStep) return '<p class="mb-0">Nothing left to do on this job.</p>';
  return `
    <button class="btn btn-primary btn-lg w-100 tech-primary" data-step="${escapeText(job.nextStep)}" data-job-id="${escapeText(job.jobId)}">
      ${escapeText(BUTTON_LABEL[job.nextStep] ?? job.nextStep)}
    </button>`;
}

// THE LAST RUNG IS NOT A BUTTON ON ITS OWN — it is the driver's code, and
// entering it is what CHARGES THEM. That consequence lived in a code comment
// until Phase 22b's audit; on screen this looked like an arbitrary form field.
// Saying so is not a courtesy: a technician who thinks the code is a formality
// will happily type it before the work is finished.
function completionMarkup(job, state) {
  // THE PARTS PROMPT COMES FIRST, and the code input does not appear until it
  // is answered. See partsPromptMarkup for why this is a gate rather than a
  // reminder.
  const answer = state.completionParts[job.jobId];
  if (!answer) return partsPromptMarkup(job, state);

  return `
    ${answer === 'FITTING' ? partsPickerMarkup(job, state) : ''}
    <div class="capture-card">
      <label class="form-label mb-1" for="completion-code">
        Ask the driver for their 6-digit code.
      </label>
      <p class="small text-secondary mb-2">
        Type it here when the work is finished. ${completionConsequence(job)}
      </p>
      <input id="completion-code" class="form-control form-control-lg mb-2"
             inputmode="numeric" autocomplete="off" placeholder="000 000" />
      <button class="btn btn-primary btn-lg w-100 tech-primary" data-step="COMPLETE" data-job-id="${escapeText(job.jobId)}">
        ${escapeText(BUTTON_LABEL.COMPLETE)}
      </button>
    </div>`;
}

// WHAT ENTERING THE CODE ACTUALLY DOES, which is not the same sentence on every
// job. A contract job that absorbs the whole bill takes NOTHING from the driver,
// and the browser walk-through found this card promising to take "₹0.00 from the
// driver's card" — a sentence that is both false and, worse, teaches a
// technician that the warning above the box is boilerplate. Three cases because
// there are genuinely three: nothing to take, a known amount, and an amount
// nobody has priced yet.
// THE LAST CHANCE TO SAY WHAT CAME OUT OF THE VAN.
//
// "Fitted one" lives on the van panel and is available at any rung, which is
// correct — a technician fits a part when they fit it, not when they finish.
// What was missing is that nothing ever ASKED. A technician who forgets closes
// the job with the van's count silently wrong, and that count is not cosmetic:
// stock confidence feeds the next dispatch's part-availability decision
// (Phase 19 refuses to dispatch on an UNVERIFIED shelf), so one forgotten tap
// sends the next van out believing it carries a battery it does not.
//
// A GATE, NOT A REMINDER. The code input does not render until this is
// answered. A reminder next to a button is a reminder people stop seeing; two
// buttons, one of which is "nothing", costs a tap and cannot be skipped by
// accident. "Nothing from the van" is a real and common answer — a jump start
// or a lockout consumes nothing — so it is offered as an equal, not buried.
function partsPromptMarkup(job, state) {
  const offline = !state.outbox.online;
  return `
    <div class="capture-card">
      <p class="mb-1"><strong>Before you finish — did you fit anything from the van?</strong></p>
      <p class="small text-secondary mb-2">
        This keeps the van's count right for whoever is dispatched next.
      </p>
      <div class="d-grid gap-2">
        <button class="btn btn-outline-secondary btn-lg tech-action" data-parts-answer="FITTING"
                data-job-id="${escapeText(job.jobId)}">
          Yes — let me record it
        </button>
        <button class="btn btn-outline-secondary btn-lg" data-parts-answer="NONE"
                data-job-id="${escapeText(job.jobId)}">
          Nothing from the van
        </button>
      </div>
      ${offline ? '<p class="small text-secondary mb-0 mt-2">Anything you record will send when you are back online.</p>' : ''}
    </div>`;
}

// Only the parts actually ON BOARD. A shelf at zero cannot have been fitted
// from, and listing all fourteen lines here would turn the completion card into
// the van panel — which is directly below, for the case where the count itself
// is wrong.
function partsPickerMarkup(job, state) {
  const lines = (state.van.stock?.lines ?? []).filter((line) => line.quantity > 0);
  if (lines.length === 0) {
    return `
      <div class="context-card mb-3">
        <div class="context-title">What you fitted</div>
        <p class="small mb-0">This van has nothing on board to record.</p>
      </div>`;
  }

  return `
    <div class="context-card mb-3">
      <div class="context-title">What you fitted</div>
      <p class="small text-secondary mb-2">
        Tap once per part fitted. Each tap goes into the same queue as everything
        else on this page.
      </p>
      <ul class="list-unstyled mb-0">
        ${lines
          .map(
            (line) => `
              <li class="d-flex justify-content-between align-items-center gap-2 py-1">
                <span>${escapeText(line.name)}
                  <span class="small text-secondary">${escapeText(line.quantity)} on board</span>
                </span>
                <button class="btn btn-sm btn-outline-primary" data-fitted="${escapeText(line.partId)}"
                        data-job-id="${escapeText(job.jobId)}">Fitted one</button>
              </li>`,
          )
          .join('')}
      </ul>
    </div>`;
}

// THE PAYMENT CONSEQUENCE SURVIVES THE REWRITE, and that is deliberate: this
// sentence exists because the box once took money without saying so. It is
// shorter now and says the same thing.
function completionConsequence(job) {
  if (job.estimate && job.estimate.payablePaise === 0) {
    return `<strong>The driver pays nothing</strong> — their company pays.`;
  }
  const amount = job.estimate ? rupees(job.estimate.payablePaise) : 'the agreed amount';
  return `This <strong>takes payment</strong> — ${escapeText(amount)} from the driver.`;
}

// WHAT THE QUEUE IS HOLDING, and what came back. Both on screen: a tap that
// went into a queue and a tap that was refused look identical to a technician
// otherwise, and only one of them means "do it again".
export function renderOutbox(state) {
  const banner = document.querySelector('[data-field="outbox"]');
  if (banner) {
    const count = state.outbox.pending.length;
    // THREE STATES, NOT TWO. A queue holding taps while offline and a queue
    // actively sending them look the same to somebody watching the screen, and
    // the second one resolves itself while the first needs signal.
    const text =
      count === 0
        ? ''
        : state.outbox.online
          ? `Sending ${count} ${count === 1 ? 'action' : 'actions'}…`
          : `${count} ${count === 1 ? 'action is' : 'actions are'} waiting to send. They will go in order as soon as you are back online.`;
    if (banner.textContent !== text) banner.textContent = text;
    banner.hidden = count === 0;
  }

  const network = document.querySelector('[data-field="network"]');
  if (network) {
    const text = state.outbox.online ? 'online' : 'offline';
    if (network.textContent !== text) network.textContent = text;
    const className = `badge ${state.outbox.online ? 'text-bg-success' : 'text-bg-danger'}`;
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

function rupees(paise) {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeText(value) {
  const node = document.createElement('div');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}
