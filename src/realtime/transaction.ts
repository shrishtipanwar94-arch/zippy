// A TRANSACTION WHOSE JOB EVENTS ACTUALLY REACH A BROWSER.
//
// THE BUG THIS EXISTS TO FIX, stated plainly because it survived four phases.
//
// `appendJobEvent` calls `recordForPublish`, which pushes onto the outbox
// buffer held in AsyncLocalStorage. That buffer only exists inside
// `collectJobEvents(...)`. Until now the ONLY caller of `collectJobEvents` was
// `runIntakeTransaction` — so intake's events were fanned out, and every event
// written by any other path was not. The saga committing a reservation, an
// offer being accepted, a technician marking themselves on scene, a confirmed
// promotion escalating a job to HIGH_RISK: all correctly stored in
// `job_events`, all silently never broadcast.
//
// It was invisible from the outside for the worst possible reason — it looked
// like it worked. `recordForPublish` finds no store and does nothing, which is
// the CORRECT behaviour for a seed or a script and indistinguishable from a
// dropped event for a route. And the clients hide it: a reconnect replays from
// `job_events`, so a page reload always showed the right thing, and every
// surface that polls or refetches after its own action looked live. Only a
// second browser watching a job somebody ELSE was changing would have shown
// nothing — which is exactly what a promotion confirmed on the driver's phone
// is, and how it was finally caught.
//
// So the outbox was never wrong; it just had one user. This is the wrapper
// every other writer needed, and it is deliberately the same two lines
// `runIntakeTransaction` already had:
//
//   collect the events an attempt produced -> commit -> publish what committed
//
// WHY NOT PUBLISH INSIDE `appendJobEvent`. Because the transaction has not
// committed yet and may still roll back — `runIntakeTransaction` deliberately
// rolls back and replays on a sequence collision. Emitting there would push
// events to browsers that the database then threw away, and a browser cannot
// un-see an event. See outbox.ts.

import type { Prisma, PrismaClient } from '@prisma/client';
import { collectJobEvents } from './outbox.js';
import { publishJobEvents } from './publish.js';

export async function runPublishingTransaction<T>(
  db: PrismaClient,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  const { result, events } = await collectJobEvents(() => db.$transaction(work, options));
  // After the commit, never during. A failure here is logged and swallowed by
  // `publishJobEvents` — the row is already durable, and the client's reconnect
  // replay catches it up regardless.
  await publishJobEvents(events);
  return result;
}

// The same guarantee for a writer that is not opening a transaction of its own
// — several commit paths do a bare `updateMany` and then append an event
// through a short transaction they would rather not restructure.
export async function publishingAfter<T>(work: () => Promise<T>): Promise<T> {
  const { result, events } = await collectJobEvents(work);
  await publishJobEvents(events);
  return result;
}
