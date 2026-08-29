// Every state transition writes a JobEvent. It is a project convention, and
// from Phase 4 the socket fan-out replays this table so a reconnecting client
// can ask for "everything after sequence N" and catch up in order.
//
// The sequence is per job and unique, and nothing in Postgres hands out such a
// counter for us, so the writer reads the current maximum and writes max+1.
// When two writers collide, one loses the unique constraint and its whole
// transaction is retried — see transaction.ts for why the retry cannot live
// here.
//
// The table is append-only, enforced by a database trigger (Phase 1 migration).
// A mistake is corrected by writing a compensating event, never by an UPDATE.

import type { Prisma } from '@prisma/client';
import { recordForPublish } from '../realtime/outbox.js';

export type JobEventInput = {
  jobId: string;
  eventType: string;
  payload?: Prisma.InputJsonValue;
  actorRole?: string | null;
  actorId?: string | null;
  at?: Date;
};

export async function appendJobEvent(
  tx: Prisma.TransactionClient,
  event: JobEventInput,
): Promise<number> {
  const last = await tx.jobEvent.findFirst({
    where: { jobId: event.jobId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });
  const sequence = (last?.sequence ?? 0) + 1;

  const at = event.at ?? new Date();

  await tx.jobEvent.create({
    data: {
      jobId: event.jobId,
      sequence,
      eventType: event.eventType,
      payload: event.payload ?? {},
      actorRole: event.actorRole ?? null,
      actorId: event.actorId ?? null,
      at,
    },
  });

  // Queued, not emitted. The transaction can still roll back and replay, and a
  // browser cannot un-see an event — see src/realtime/outbox.ts.
  recordForPublish({
    jobId: event.jobId,
    sequence,
    eventType: event.eventType,
    payload: event.payload ?? {},
    at,
  });

  return sequence;
}
