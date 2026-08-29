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

export function login(email, password) {
  return request('POST', '/auth/login', { email, password });
}

export function listJobs() {
  return request('GET', '/jobs');
}

export function listUnits() {
  return request('GET', '/units');
}

export function assignUnit(jobId, unitId) {
  return request('PATCH', `/jobs/${jobId}/assign`, { unitId });
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
