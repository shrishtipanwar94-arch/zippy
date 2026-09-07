// Typed intake failures. The route maps these to status codes in one place —
// no handler decides what a 404 means on its own, and nothing throws a bare
// string.

export type IntakeErrorCode =
  | 'DRIVER_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'NO_ZONE_CONFIGURED'
  // The coordinate is real and well-formed and simply is not somewhere we
  // work. Not a validation failure — nothing about the request is malformed —
  // which is why it is 422 rather than 400.
  | 'OUTSIDE_SERVICE_AREA'
  | 'INTAKE_ALREADY_COMPLETE'
  | 'QUESTION_NOT_PENDING'
  | 'ANSWER_NOT_ALLOWED'
  | 'EVENT_SEQUENCE_CONTENDED';

export class IntakeError extends Error {
  readonly code: IntakeErrorCode;

  constructor(code: IntakeErrorCode, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

const STATUS_BY_CODE: Record<IntakeErrorCode, number> = {
  DRIVER_NOT_FOUND: 404,
  VEHICLE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  NO_ZONE_CONFIGURED: 500,
  OUTSIDE_SERVICE_AREA: 422,
  INTAKE_ALREADY_COMPLETE: 409,
  QUESTION_NOT_PENDING: 409,
  ANSWER_NOT_ALLOWED: 400,
  EVENT_SEQUENCE_CONTENDED: 503,
};

export function statusForIntakeError(error: IntakeError): number {
  return STATUS_BY_CODE[error.code];
}

// WHICH FAILURES CARRY A MESSAGE WRITTEN FOR THE PERSON WHO HIT THEM.
//
// Most IntakeError messages are developer text — "no zones are configured; run
// the seed" is a note to whoever deployed this, and putting it in front of
// somebody standing next to a broken car would be worse than saying nothing.
// So a message reaches the driver only if it was written for them, and this
// set is the whole of that decision.
//
// The alternative — a second wording table keyed by code — is a second place
// for the sentence to live and drift from the one the thrower wrote. One
// sentence, at the point that knows the distance and the city.
const DRIVER_READABLE: ReadonlySet<IntakeErrorCode> = new Set(['OUTSIDE_SERVICE_AREA']);

export function driverMessageFor(error: IntakeError): string | null {
  return DRIVER_READABLE.has(error.code) ? error.message : null;
}
