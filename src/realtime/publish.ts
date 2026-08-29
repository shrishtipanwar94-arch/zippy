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

import type { Server } from 'socket.io';
import { prismaBase } from '../infra/prismaBase.js';
import { logger } from '../infra/logger.js';
import { roomsForJobEvent } from './rooms.js';
import type { PublishableJobEvent } from './outbox.js';

// The realtime server is optional. The simulator, the seed and the test suite
// all write job events in processes with no Socket.IO attached, and they must
// not crash for want of a listener.
let server: Server | null = null;

export function setRealtimeServer(io: Server | null): void {
  server = io;
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
};

export async function publishJobEvents(events: PublishableJobEvent[]): Promise<void> {
  if (!server || events.length === 0) return;

  // Routing needs the job's zone and tenant, which the event itself does not
  // carry. One read per job, after commit and outside the transaction, so a
  // slow read cannot hold a write lock open.
  const jobIds = [...new Set(events.map((event) => event.jobId))];
  const jobs = await prismaBase.job.findMany({
    where: { id: { in: jobIds } },
    select: { id: true, zoneId: true, tenantId: true },
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
    };

    // `to()` takes the whole list and unions it, and Socket.IO delivers once
    // per socket — a dispatcher in both the job room and the zone room gets
    // one copy, not two.
    server.to(roomsForJobEvent(job)).emit('job:event', message);
  }
}
