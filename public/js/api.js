// Every HTTP call the pages make. Thin on purpose — it adds the bearer token
// and turns a non-2xx into a thrown Error, and does nothing else. No caching,
// no retry: WebSocket is the mechanism for staying current (Phase 4), and
// polling is the Phase 17 fallback, not the design.

import { getState } from './state.js';

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const { token } = getState();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text.length > 0 ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(payload?.error ?? `${method} ${path} failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

// THE LADDER. Unauthenticated on purpose — /health is the endpoint a load
// balancer hits, and a console that could only see the system's state once
// signed in would show a blank page during exactly the outage it exists for.
export function getHealth() {
  return request('GET', '/health');
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

export function solveJobs() {
  return request('POST', '/solve');
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

// --- the driver's live page ------------------------------------------------

// One request for the whole panel, already in English. See src/api/driver.ts
// for why the translation is the server's job and not this file's.
export function getDriverView(jobId) {
  return request('GET', `/jobs/${jobId}/driver-view`);
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

// --- the fleet manager's dashboard (Phase 21) --------------------------------

export function getFleetDashboard() {
  return request('GET', '/fleet/dashboard');
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
