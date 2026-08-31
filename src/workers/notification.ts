// ONE MESSAGE PER RE-PLAN, NOT SIX.
//
// A re-plan fires a burst of events in about ninety seconds: the old crew is
// released, the reservation is requeued, a new unit is held, a technician is
// offered the job, they accept, the reservation commits, an ETA is recorded.
// Every one of those is a true and useful fact to a dispatcher. To the driver
// they are one thing happening, and telling them six times — "your technician
// has been released", "we are finding someone", "we found someone", … — is
// worse than telling them nothing, because it reads as a system in trouble.
//
// THE COALESCING IS NOT "PICK ONE OF THE SIX". That is the trap, and it cannot
// work: whichever event you pick, you are describing a moment mid-flight that
// may already be false by the time it lands. What this does instead is WAIT,
// and then describe the state the job has ARRIVED at — the notification body is
// composed at delivery time from the job as it then is, not from the event that
// triggered it. So a driver whose job was re-planned three times in two minutes
// gets one message, and it is about where things actually ended up.
//
// That is also why the body comes from `driverNarrative.headlineFor`: it is the
// same sentence their live page shows, from the same map, so a notification can
// never contradict the screen it points at.
//
// THE MECHANISM is the debounce helper the solver queue uses (queues/debounce.ts)
// keyed on the JOB rather than on a zone — same problem, many triggers and one
// run, so not a second implementation. The first trigger in the window creates
// a delayed job and claims the key; every trigger after it is absorbed.

import type { Job } from 'bullmq';
import { queues } from '../queues/queues.js';
import { enqueueDebounced } from '../queues/debounce.js';
import { runIdempotently } from '../queues/idempotent.js';
import { prismaBase } from '../infra/prismaBase.js';
import { logger } from '../infra/logger.js';
import { headlineFor } from '../domain/driverNarrative.js';
import { publishNotification } from '../realtime/publish.js';

// NINETY SECONDS, which is the brief's own figure for how long a re-plan storm
// lasts. It is long enough that the usual case — a dispatcher executing a
// recommendation and a technician accepting inside their forty-five-second
// offer window — has settled before the message is composed. It is not a
// measured number, and the honest failure mode is a re-plan that takes longer:
// the driver then gets one truthful message about an unsettled state ("Finding
// someone equipped for this") rather than a stale one, which is the right way
// for this to be wrong.
const REPLAN_COALESCE_MS = 90_000;

export type NotificationJobData = {
  jobId: string;
  reason: string;
};

// Called wherever a re-plan begins. Safe to call repeatedly — that is the point.
export async function notifyDriverOfReplan(jobId: string, reason: string): Promise<void> {
  await enqueueDebounced(
    queues.notification,
    'driver-replan',
    // The coalesce key is the JOB plus the kind of thing being said. Keying on
    // the job alone would collapse a re-plan and an unrelated future
    // notification type into one message.
    `job:${jobId}:replan`,
    { jobId, reason } satisfies NotificationJobData,
    REPLAN_COALESCE_MS,
  );
}

export async function processNotification(job: Job): Promise<void> {
  const data = job.data as NotificationJobData;
  if (!data?.jobId) {
    await job.log('no jobId on this notification; nothing to send');
    return;
  }

  // The queue delivers at least once. Without this, a redelivery after a crash
  // writes the driver a second copy of a message whose whole purpose was to be
  // the only one.
  await runIdempotently('notification', job.id!, async () => {
    await deliverReplanNotification(data);
  });
}

async function deliverReplanNotification(data: NotificationJobData): Promise<void> {
  // READ THE JOB NOW, not when the trigger fired. This is the coalescing.
  const job = await prismaBase.job.findUnique({
    where: { id: data.jobId },
    select: {
      id: true,
      status: true,
      driver: { select: { userId: true } },
      assignedTechnician: { select: { user: { select: { name: true } } } },
      etaEstimates: {
        orderBy: { computedAt: 'desc' },
        take: 1,
        select: { etaSeconds: true, computedAt: true },
      },
    },
  });
  if (!job?.driver?.userId) {
    logger.warn({ jobId: data.jobId }, 'replan notification has no driver to reach');
    return;
  }

  const eta = job.etaEstimates[0];
  const fullName = job.assignedTechnician?.user.name ?? null;

  const body = headlineFor({
    status: job.status,
    helperName: fullName ? (fullName.split(' ')[0] ?? fullName) : null,
    arrivingAt: eta ? new Date(eta.computedAt.getTime() + eta.etaSeconds * 1000) : null,
    // By the time this fires the re-plan is over — that is what the wait was
    // for — so the message describes the settled state rather than the churn.
    replanning: false,
    intakeComplete: true,
  });

  const notification = await prismaBase.notification.create({
    data: {
      jobId: job.id,
      recipientId: job.driver.userId,
      channel: 'SOCKET',
      title: 'Update on your breakdown',
      body,
      // Stored as well as used for the debounce, so "why did this driver get
      // one message and not six?" is answerable from the table afterwards.
      coalesceKey: `job:${job.id}:replan`,
      sentAt: new Date(),
    },
    select: { id: true, title: true, body: true, createdAt: true },
  });

  await publishNotification(job.id, {
    notificationId: notification.id,
    jobId: job.id,
    title: notification.title,
    body: notification.body,
    at: notification.createdAt.toISOString(),
  });
}
