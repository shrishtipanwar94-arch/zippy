// MANUAL ASSIGNMENT — a dispatcher picks a unit from a dropdown.
//
// PLACEHOLDER. Phase 9 replaces this entirely with allocation: candidates,
// feasibility filtering, a cost function, and the reservation saga in Phase 12.
// This exists so the Phase 4 walking skeleton has an action a dispatcher can
// take that the driver and technician surfaces visibly react to. Delete it at
// Phase 9, along with the `jobAssignment` permission and the route.
//
// It is a placeholder, NOT a shortcut past the invariants:
//
// ONE ACTIVE JOB PER UNIT (invariant 7). A unit is taken only if it is still
// AVAILABLE, and the check and the claim are the same statement — a conditional
// UPDATE, not a read followed by a write. Two dispatchers picking the same unit
// at the same moment both pass a `findFirst` that says AVAILABLE; only one can
// win an UPDATE that says `WHERE status = 'AVAILABLE' AND version = <what I
// read>`.
//
// OPTIMISTIC LOCKING. Rather than locking the rows and holding a transaction
// open, both the unit and the job are updated conditionally on the version that
// was read. If someone got there first the version moved, zero rows change, and
// this writer knows it lost. That is the pattern the whole commit path uses
// from Phase 11; this is its first real use.
//
// BOTH UPDATES IN ONE TRANSACTION, because they can fail independently. Taking
// the unit and then failing to attach it to the job would leave a unit marked
// ON_JOB with no job to be on — invisible, and it would never come back.

import type { Prisma, PrismaClient } from '@prisma/client';
// Generic despite the name: it retries the whole transaction on a job-event
// sequence collision and flushes the realtime outbox after commit. Worth
// renaming when Phase 12 builds the real commit path.
import { runIntakeTransaction } from '../intake/transaction.js';
import { appendJobEvent } from '../intake/events.js';

export type AssignmentErrorCode =
  | 'JOB_NOT_FOUND'
  | 'UNIT_NOT_FOUND'
  | 'UNIT_NOT_AVAILABLE'
  | 'JOB_NOT_ASSIGNABLE'
  | 'LOST_RACE';

export class AssignmentError extends Error {
  readonly code: AssignmentErrorCode;

  constructor(code: AssignmentErrorCode, message: string) {
    super(message);
    this.name = 'AssignmentError';
    this.code = code;
  }
}

const STATUS_BY_CODE: Record<AssignmentErrorCode, number> = {
  JOB_NOT_FOUND: 404,
  UNIT_NOT_FOUND: 404,
  UNIT_NOT_AVAILABLE: 409,
  JOB_NOT_ASSIGNABLE: 409,
  // 409, not 500: losing the race is a legitimate outcome the caller can
  // retry with a different unit, not a server fault.
  LOST_RACE: 409,
};

export function statusForAssignmentError(error: AssignmentError): number {
  return STATUS_BY_CODE[error.code];
}

// A job that has already been resolved or cancelled cannot take a unit. INTAKE
// and PLANNED are the states a manual pick makes sense in.
const ASSIGNABLE_JOB_STATUSES = new Set(['INTAKE', 'PLANNED']);

export type AssignmentResult = {
  jobId: string;
  unitId: string;
  technicianId: string | null;
};

export async function assignUnitToJob(
  db: PrismaClient,
  input: { jobId: string; unitId: string; actor: { role: string; id: string } },
): Promise<AssignmentResult> {
  return runIntakeTransaction(db, async (tx) => {
    const job = await tx.job.findUnique({
      where: { id: input.jobId },
      select: { id: true, status: true, version: true, assignedUnitId: true },
    });
    if (!job) throw new AssignmentError('JOB_NOT_FOUND', `no job ${input.jobId}`);
    if (!ASSIGNABLE_JOB_STATUSES.has(job.status)) {
      throw new AssignmentError('JOB_NOT_ASSIGNABLE', `job is ${job.status}`);
    }

    const unit = await tx.unit.findUnique({
      where: { id: input.unitId },
      select: { id: true, status: true, version: true, currentTechnicianId: true },
    });
    if (!unit) throw new AssignmentError('UNIT_NOT_FOUND', `no unit ${input.unitId}`);
    if (unit.status !== 'AVAILABLE') {
      throw new AssignmentError('UNIT_NOT_AVAILABLE', `unit is ${unit.status}`);
    }

    await takeUnit(tx, unit);
    await attachToJob(tx, job, unit);

    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'UNIT_ASSIGNED',
      payload: {
        unitId: unit.id,
        technicianId: unit.currentTechnicianId,
        // So the board can tell a manual pick from a solver decision once
        // Phase 9 lands and both exist in the history.
        source: 'MANUAL_DISPATCHER_PICK',
      },
      actorRole: input.actor.role,
      actorId: input.actor.id,
    });

    return { jobId: job.id, unitId: unit.id, technicianId: unit.currentTechnicianId };
  });
}

// The claim. `updateMany` rather than `update` because it reports how many rows
// it changed instead of throwing — zero means someone else took this unit
// between the read above and here.
async function takeUnit(
  tx: Prisma.TransactionClient,
  unit: { id: string; version: number },
): Promise<void> {
  const claimed = await tx.unit.updateMany({
    where: { id: unit.id, version: unit.version, status: 'AVAILABLE' },
    data: { status: 'ON_JOB', version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    throw new AssignmentError('LOST_RACE', 'another dispatcher took this unit first');
  }
}

async function attachToJob(
  tx: Prisma.TransactionClient,
  job: { id: string; version: number },
  unit: { id: string; currentTechnicianId: string | null },
): Promise<void> {
  const attached = await tx.job.updateMany({
    where: { id: job.id, version: job.version },
    data: {
      assignedUnitId: unit.id,
      assignedTechnicianId: unit.currentTechnicianId,
      // PLANNED, not COMMITTED: a plan exists, but nothing has been offered to
      // a technician or accepted. COMMITTED means the three-leg reservation
      // saga has completed, and that arrives in Phase 12.
      status: 'PLANNED',
      version: { increment: 1 },
    },
  });
  if (attached.count === 0) {
    throw new AssignmentError('LOST_RACE', 'the job changed while it was being assigned');
  }
}
