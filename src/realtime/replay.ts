// RECONNECT REPLAY — what a client missed while its socket was down.
//
// A WebSocket that drops loses every event sent while it was away, and the
// client cannot tell the difference between "nothing happened" and "I missed
// four things". So on resubscribe it says how far it got — its
// lastEventSequence for that job — and gets back everything after it, in
// order.
//
// THE CURSOR IS PER JOB, because `sequence` is per job. `job_events` has a
// unique (job_id, sequence) and no global counter, so "everything after N" is
// only a well-formed question about one job. That is enough for the driver and
// technician surfaces, which watch a single breakdown. It is NOT enough for a
// dispatcher watching a whole zone: there is no monotonic column that orders
// events across jobs, and `at` cannot stand in for one — the simulator writes
// historical timestamps, so `at` is not even monotonic with insertion order.
// A zone-wide client resyncs by refetching its job list over HTTP instead.
// Recorded as a weakness; a global event sequence is the real fix.
//
// DELIVERY IS AT-LEAST-ONCE, AND THAT IS DELIBERATE.
// The socket joins the room BEFORE the replay is read, which means an event
// committed in that window can arrive live AND appear in the replay. The
// alternative — read first, then join — loses any event committed in between,
// and a gap is far worse than a repeat: a duplicate is detectable by the
// client, a missing event is not. So the contract is that the client applies
// events in increasing sequence order and ignores any sequence it has already
// applied. That one rule handles duplicates and out-of-order arrival together.

import type { Prisma } from '@prisma/client';
import { prismaBase } from '../infra/prismaBase.js';
import type { JobEventMessage } from './publish.js';

// A client that has been away long enough to miss more than this is not
// replayed at all — it is told to resync. Feeding it a partial history would
// leave it confidently wrong, which is worse than making it refetch.
export const MAX_REPLAY_EVENTS = 500;

export type ReplayResult = {
  jobId: string;
  events: JobEventMessage[];
  // The highest sequence this replay covers. A client can ignore any live
  // event at or below it that it has already applied.
  throughSequence: number;
  // True when the client missed more than the cap. `events` is empty and the
  // client must refetch the job from scratch rather than trust a partial tail.
  truncated: boolean;
};

function toMessage(row: {
  jobId: string;
  sequence: number;
  eventType: string;
  payload: Prisma.JsonValue;
  at: Date;
}): JobEventMessage {
  return {
    jobId: row.jobId,
    sequence: row.sequence,
    eventType: row.eventType,
    payload: row.payload,
    at: row.at.toISOString(),
  };
}

export async function replayJobEvents(
  jobId: string,
  afterSequence: number,
  limit: number = MAX_REPLAY_EVENTS,
): Promise<ReplayResult> {
  // One more than the cap, so a full page is distinguishable from an
  // overflowing one without a second count query.
  const rows = await prismaBase.jobEvent.findMany({
    where: { jobId, sequence: { gt: afterSequence } },
    orderBy: { sequence: 'asc' },
    take: limit + 1,
    select: { jobId: true, sequence: true, eventType: true, payload: true, at: true },
  });

  if (rows.length > limit) {
    return { jobId, events: [], throughSequence: afterSequence, truncated: true };
  }

  const events = rows.map(toMessage);
  return {
    jobId,
    events,
    throughSequence: events[events.length - 1]?.sequence ?? afterSequence,
    truncated: false,
  };
}
