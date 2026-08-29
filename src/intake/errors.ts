// Typed intake failures. The route maps these to status codes in one place —
// no handler decides what a 404 means on its own, and nothing throws a bare
// string.

export type IntakeErrorCode =
  | 'DRIVER_NOT_FOUND'
  | 'VEHICLE_NOT_FOUND'
  | 'JOB_NOT_FOUND'
  | 'NO_ZONE_CONFIGURED'
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
  INTAKE_ALREADY_COMPLETE: 409,
  QUESTION_NOT_PENDING: 409,
  ANSWER_NOT_ALLOWED: 400,
  EVENT_SEQUENCE_CONTENDED: 503,
};

export function statusForIntakeError(error: IntakeError): number {
  return STATUS_BY_CODE[error.code];
}
