// PUBLISH AFTER COMMIT, NEVER DURING
//
// The rule is "every JobEvent write publishes to the right rooms, one code
// path". The obvious way to get that is to emit inside `appendJobEvent`, right
// after the insert. It is also wrong: that insert is inside a transaction that
// has not committed yet, and `runIntakeTransaction` deliberately ROLLS BACK AND
// REPLAYS on a sequence collision. Emitting there would push events to browsers
// that the database then threw away — a dispatcher board showing a job that
// does not exist, and no way to take it back.
//
// So writes go into a per-transaction outbox instead. `collectJobEvents` runs
// the transaction with a fresh buffer; `recordForPublish` fills it; only after
// the transaction resolves successfully does the caller publish what the buffer
// holds. A failed attempt's buffer is dropped with the attempt.
//
// The buffer rides on AsyncLocalStorage — the same mechanism the auth context
// uses — so `appendJobEvent` does not need an extra parameter threaded through
// every call site, and a caller cannot forget to pass it.
//
// This is the classic transactional-outbox shape with one honest simplification:
// the outbox is in memory, not a table. If the process dies between commit and
// publish, those events are never broadcast. They are not lost — they are in
// `job_events`, and the reconnect cursor replays them — but a client that stays
// connected through the crash will not see them until it reconnects.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@prisma/client';

export type PublishableJobEvent = {
  jobId: string;
  sequence: number;
  eventType: string;
  payload: Prisma.InputJsonValue;
  at: Date;
};

const storage = new AsyncLocalStorage<PublishableJobEvent[]>();

// Appends to the buffer of the transaction currently in flight. Outside one —
// a seed, a script, a test that writes directly — there is no buffer and this
// does nothing, which is the correct behaviour rather than an error: those
// writers have no browser waiting on them.
export function recordForPublish(event: PublishableJobEvent): void {
  storage.getStore()?.push(event);
}

export async function collectJobEvents<T>(
  work: () => Promise<T>,
): Promise<{ result: T; events: PublishableJobEvent[] }> {
  const events: PublishableJobEvent[] = [];
  const result = await storage.run(events, work);
  return { result, events };
}
