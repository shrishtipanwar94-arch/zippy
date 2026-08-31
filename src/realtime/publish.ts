// THE ONE FAN-OUT POINT. Every job event that reaches a browser passes through
// `publishJobEvents`, and nothing else in the codebase calls `io.emit`.
//
// The discipline matters more than it looks. Scattered emits are how a realtime
// system rots: one route remembers to notify the zone room, the next one only
// notifies the job room, and six weeks later nobody can answer "who sees this
// event" without grepping. With one function the answer is a single file, and
// adding a fourth room type is a change in `roomsForJobEvent` rather than an
// audit of every write path.
//
// Called only AFTER a transaction commits — see outbox.ts for why.

import { prismaBase } from '../infra/prismaBase.js';
import { logger } from '../infra/logger.js';
import { roomsForJobEvent } from './rooms.js';
import type { PublishableJobEvent } from './outbox.js';

// TWO WAYS TO REACH A BROWSER, ONE INTERFACE. The web process holds the real
// Socket.IO `Server` that browsers actually connect to, and `setRealtimeServer`
// installs it. Every OTHER process that writes a job event — the worker, the
// simulator CLI — has no browser connected to it at all, so `.to(rooms).emit()`
// on a real `Server` there would have nothing to deliver to. Those processes
// fall back to a lightweight `Emitter` (`@socket.io/redis-emitter`) that
// PUBLISHES the same message over Redis instead of delivering it directly; the
// web process's `Server`, wired to `@socket.io/redis-adapter` in
// realtime/server.ts, subscribes to that channel and delivers it to whichever
// of ITS sockets are in the room. `Server.to().emit()` and `Emitter.to().emit()`
// share the same shape, so `publishJobEvents` below does not need to know or
// care which one it is holding — that is what `Emittable` captures.
type Emittable = { to(rooms: string[]): { emit(event: string, payload: unknown): void } };

let server: Emittable | null = null;

export function setRealtimeServer(io: Emittable | null): void {
  server = io;
}

// Built once, lazily, the first time a non-web process needs to publish. Not
// built eagerly at import time: the seed and most tests never publish
// anything, and eagerly opening a Redis connection for them would be a
// connection they never needed.
let fallbackEmitter: Emittable | null = null;

async function emitterFallback(): Promise<Emittable> {
  if (!fallbackEmitter) {
    const [{ Emitter }, { createRealtimeRedisConnection }] = await Promise.all([
      import('@socket.io/redis-emitter'),
      import('./redisConnection.js'),
    ]);
    fallbackEmitter = new Emitter(createRealtimeRedisConnection('emitter')) as unknown as Emittable;
  }
  return fallbackEmitter;
}

// What a client receives. Deliberately flat and small: the sequence is what a
// reconnecting client uses as its cursor, so it has to be legible without
// unpacking the payload.
export type JobEventMessage = {
  jobId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  at: string;
  // Carried from Phase 14. The console's incident timeline filters by zone and
  // colours by safety level, and a pushed event that lacked them would have to
  // be rendered blank or trigger a lookup per event — which is a fetch per
  // arrival on the exact panel that exists to avoid fetching. Both are free
  // here: routing already reads the job to pick its rooms.
  zoneId: string;
  safetyLevel: string;
};

export async function publishJobEvents(events: PublishableJobEvent[]): Promise<void> {
  if (events.length === 0) return;

  // BEST-EFFORT, DELIBERATELY. Postgres is the source of truth (invariant 1);
  // by the time this runs, the transaction that produced these events has
  // already committed. A browser not finding out about it is a worse UX, not
  // a data-loss bug — the client's reconnect replay (replay.ts) catches it up
  // from `job_events` regardless. So a failure here — Redis unreachable, the
  // emitter's connection not yet ready — is logged and swallowed, never
  // thrown back at the caller. Throwing would turn "the job was created but a
  // browser has not heard about it yet" into "creating the job failed",
  // which is not true and must never be reported to a client as 500.
  try {
    const target = server ?? (await emitterFallback());
    await routeAndEmit(target, events);
  } catch (error) {
    logger.error({ err: error, count: events.length }, 'failed to publish job events');
  }
}

async function routeAndEmit(target: Emittable, events: PublishableJobEvent[]): Promise<void> {
  // Routing needs the job's zone and tenant, which the event itself does not
  // carry. One read per job, after commit and outside the transaction, so a
  // slow read cannot hold a write lock open.
  const jobIds = [...new Set(events.map((event) => event.jobId))];
  const jobs = await prismaBase.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, zoneId: true, tenantId: true, safetyLevel: true },
  });

  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  for (const event of events) {
    const job = jobsById.get(event.jobId);
    if (!job) {
      // The job was deleted between commit and publish. Nothing to route by.
      logger.warn({ jobId: event.jobId, sequence: event.sequence }, 'job event has no job to route');
      continue;
    }

    const message: JobEventMessage = {
      jobId: event.jobId,
      sequence: event.sequence,
      eventType: event.eventType,
      payload: event.payload,
      at: event.at.toISOString(),
      zoneId: job.zoneId,
      safetyLevel: job.safetyLevel,
    };

    // `to()` takes the whole list and unions it, and Socket.IO delivers once
    // per socket — a dispatcher in both the job room and the zone room gets
    // one copy, not two.
    target.to(roomsForJobEvent(job)).emit('job:event', message);
  }
}
