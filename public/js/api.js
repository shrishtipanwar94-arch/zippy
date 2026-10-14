// Every HTTP call the pages make. Thin on purpose — it adds the bearer token
// and turns a non-2xx into a thrown Error, and does nothing else. No caching,
// no retry: WebSocket is the mechanism for staying current (Phase 4), and
// polling is the Phase 17 fallback, not the design.

import { getState } from './state.js';

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: authHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) throw failure(response, payload, method, path);
  return payload;
}

// `message` FIRST, and it is usually absent. A route that has something to say
// to the person in front of the screen sends a sentence alongside the code;
// everything else sends the code alone and the surfaces show that, which is how
// a driver came to be shown "vehicle_not_found". The code is kept on the error
// either way, because handlers branch on it.
function failure(response, payload, method, path) {
  const error = new Error(
    payload?.message ?? payload?.error ?? `${method} ${path} failed (${response.status})`,
  );
  error.code = payload?.error ?? null;
  error.status = response.status;
  return error;
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const { token } = getState();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// THE LADDER. Unauthenticated on purpose — /health is the endpoint a load
// balancer hits, and a console that could only see the system's state once
// signed in would show a blank page during exactly the outage it exists for.
export function getHealth() {
  return request('GET', '/health');
}

// WHICH authorisations the banner is counting. Dispatcher-only, and separate
// from GET /health because /health is unauthenticated — a public endpoint is no
// place for a list of jobs with money outstanding.
export function getStuckPayments() {
  return request('GET', '/degraded/payments');
}

export function getChaos() {
  return request('GET', '/chaos');
}

export function setChaosSwitch(name, enabled) {
  return request('POST', `/chaos/switches/${name}`, { enabled });
}

export function runChaosAction(name, body) {
  return request('POST', `/chaos/actions/${name}`, body ?? {});
}

export function resetChaos() {
  return request('POST', '/chaos/reset');
}

// THE ACTION QUEUE (Phase 13). Everything the system would like to do and is
// waiting on a person for. RECOMMEND is executed; APPROVE has to be signed off,
// and the two are separate routes because they are different acts — see
// src/api/actions.ts.
export function listActions() {
  return request('GET', '/actions');
}

export function executeAction(actionId, note) {
  return request('POST', `/actions/${actionId}/execute`, note ? { note } : {});
}

export function approveAction(actionId, decision, note) {
  return request('POST', `/actions/${actionId}/approve`, {
    decision,
    ...(note ? { note } : {}),
  });
}

export function getEscalation(jobId) {
  return request('GET', `/jobs/${jobId}/escalation`);
}

export function decideEscalation(jobId, decision, note) {
  return request('POST', `/jobs/${jobId}/escalation`, { decision, note: note ?? null });
}

export function login(email, password) {
  return request('POST', '/auth/login', { email, password });
}

export function listJobs() {
  return request('GET', '/jobs');
}

// SOLVE IS THE ONE STREAMING CALL, and it is the only reason this file knows
// what a ReadableStream is.
//
// The server answers NDJSON — one complete JSON object per line, flushed as the
// run reaches each stage, with the full report as the last line (see the header
// of src/api/solve.ts). Reading it line by line is what lets the console show
// the solve happening instead of a spinner: `onStage` is called with each stage
// the moment it lands, and the promise resolves with the report.
//
// Failures before the first line are ordinary JSON errors with a status code,
// exactly like every other call here. A failure after it can only arrive as an
// `error` line, because the status was sent long ago.
export async function solveJobs(onStage) {
  const response = await fetch('/solve', { method: 'POST', headers: authHeaders() });

  if (!response.ok) {
    const text = await response.text();
    throw failure(response, text.length > 0 ? JSON.parse(text) : null, 'POST', '/solve');
  }

  let result = null;
  await eachJsonLine(response, (message) => {
    if (message.type === 'stage') onStage?.(message.stage);
    if (message.type === 'result') result = message;
    if (message.type === 'error') throw new Error(message.message);
  });

  if (!result) throw new Error('the solver stream ended before it produced a plan');
  return result;
}

// Chunks do not arrive on line boundaries — one read can carry two and a half
// lines — so whatever follows the last newline is held back until the rest of
// it turns up.
async function eachJsonLine(response, handle) {
  let buffer = '';
  const consume = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length > 0) handle(JSON.parse(line));
    }
  };

  if (!response.body) {
    // No streaming reader here (an older browser). Every line is still present
    // and in order; they simply all arrive at once.
    consume(await response.text());
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    // A multi-byte character can straddle two chunks, so the decoder holds the
    // first half back. This releases it.
    consume(decoder.decode());
  }

  if (buffer.trim().length > 0) handle(JSON.parse(buffer));
}

export function listEvents(filters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  const suffix = query.toString();
  return request('GET', `/events${suffix ? `?${suffix}` : ''}`);
}

export function getDecision(jobId) {
  return request('GET', `/jobs/${jobId}/decision`);
}

export function getScarcity() {
  return request('GET', '/capabilities/scarcity');
}

export function getQueue() {
  return request('GET', '/queue');
}

export function selectPlan(planVariantId, overrideReasonCode) {
  return request(
    'POST',
    `/plans/${planVariantId}/select`,
    overrideReasonCode ? { overrideReasonCode } : {},
  );
}

// Free text in, a proposed form out. Creates nothing — see src/api/intake.ts.
export function describeSymptoms(text) {
  return request('POST', '/jobs/intake/describe', { text });
}

export function createIntake(payload) {
  return request('POST', '/jobs/intake', payload);
}

export function nextQuestion(jobId) {
  return request('GET', `/jobs/${jobId}/next-question`);
}

export function answerQuestion(jobId, questionCode, answer) {
  return request('POST', `/jobs/${jobId}/answers`, { questionCode, answer });
}

// The caller's own vehicles, as number plates. A driver never types a database
// id — see the comment on GET /vehicles in src/api/vehicles.ts.
export function listVehicles() {
  return request('GET', '/vehicles');
}

// --- the driver's live page ------------------------------------------------

// One request for the whole panel, already in English. See src/api/driver.ts
// for why the translation is the server's job and not this file's.
export function getDriverView(jobId) {
  return request('GET', `/jobs/${jobId}/driver-view`);
}

// WHAT THIS DRIVER STILL HAS OPEN. Asked once at sign-in so a reload does not
// strand somebody mid-incident — see the restore in pages/driver.js.
export function getOpenJobs() {
  return request('GET', '/driver/open-jobs');
}

// --- the callout fee, through Razorpay's test-mode checkout (Phase 22b) -----

// Opens the order, or finds the one this job already has. Safe to call as often
// as the driver taps the button: the order is looked up by an idempotency key
// derived from the job, so there is only ever one.
export function startCheckout(jobId) {
  return request('POST', `/jobs/${jobId}/checkout`);
}

// What Razorpay's widget handed the browser. The server verifies the signature
// and then goes and asks the gateway itself — nothing the browser says is
// written down. See src/api/checkout.ts.
export function confirmCheckout(jobId, result) {
  return request('POST', `/jobs/${jobId}/checkout/callback`, result);
}

// --- the technician's field surface ----------------------------------------

export function getTechnicianWork() {
  return request('GET', '/technician/work');
}

export function respondToOffer(offerId, decision) {
  return request('POST', `/technician/offers/${offerId}/respond`, { decision });
}

// One rung of the status ladder. Called ONLY by the offline queue's drain —
// never straight from a button — so every action takes the same path whether
// the phone has signal or not.
export function sendTechnicianAction(action) {
  return request('POST', `/jobs/${action.jobId}/actions`, {
    idempotencyKey: action.idempotencyKey,
    step: action.step,
    clientSequence: action.clientSequence,
    eventTime: action.eventTime,
    ...(action.completionCode ? { completionCode: action.completionCode } : {}),
  });
}

// --- the van, and what came out of it (Phase 18) -----------------------------

// ON DUTY OR OFF. Writes a shift, which is what the solver already reads — see
// src/commit/technicianDuty.ts for why it is a shift and not a new flag.
export function setDuty(onDuty) {
  return request('POST', '/technician/duty', { onDuty });
}

// The technician's own running account: balance, why it stands where it does,
// and what the next payout run will do about it. See
// src/commit/technicianEarnings.ts for why a negative balance needs a sentence.
export function getTechnicianEarnings() {
  return request('GET', '/technician/earnings');
}

export function getVanStock() {
  return request('GET', '/technician/stock');
}

// A COUNT, not a correction. `confirmationId` is minted by the caller at the
// tap, so sending the same count twice records one confirmation rather than
// two — see src/commit/stockConfirmations.ts.
export function confirmVanStock(confirmationId, counted) {
  return request('POST', '/technician/stock/confirm', {
    confirmationId,
    counted,
    confirmedAt: new Date().toISOString(),
  });
}

// WHAT WAS FITTED. Called ONLY by the offline queue's drain, exactly like a
// ladder action: the declaration id IS the queue item's key, minted at the tap
// and unchanged by every retry, and each line's stock movement id derives from
// it. That is what makes a double tap, or a replay off the queue, decrement
// once.
export function declarePartsUsed(action) {
  return request('POST', `/jobs/${action.jobId}/parts-used`, {
    declarationId: action.idempotencyKey,
    lines: action.lines,
    eventTime: action.eventTime,
  });
}

export function submitDiagnosis(jobId, primaryComplaint, note) {
  return request('POST', `/jobs/${jobId}/diagnosis`, {
    symptoms: { primaryComplaint },
    ...(note ? { note } : {}),
  });
}

// --- chat, and the promotions it raises -------------------------------------

export function listMessages(jobId) {
  return request('GET', `/jobs/${jobId}/messages`);
}

export function sendMessage(jobId, payload) {
  return request('POST', `/jobs/${jobId}/messages`, payload);
}

export function listPromotions(jobId) {
  return request('GET', `/jobs/${jobId}/promotions`);
}

// A person answering the question a flagged message raised. This is the only
// call in the whole client that can turn a message into a dispatch change, and
// it exists precisely so that nothing else can.
export function confirmPromotion(promotionId, decision) {
  return request('POST', `/promotions/${promotionId}/confirm`, { decision });
}

// --- estimates and approval -------------------------------------------------

// The technician prices what they found. Online only: it reads the job's
// pinned price list and its diagnosis, neither of which the phone holds.
export function raiseEstimate(jobId, towKilometres) {
  return request('POST', `/jobs/${jobId}/estimate`, towKilometres ? { towKilometres } : {});
}

// The driver's answer. The only call in the client that can unpause a job.
export function respondToEstimate(estimateId, decision) {
  return request('POST', `/estimates/${estimateId}/respond`, { decision });
}
