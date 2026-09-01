// TWO COALESCING WINDOWS, ONE MECHANISM — a driver's ninety seconds and a
// fleet manager's much wider one (Phase 21). See the block below the driver
// section for why a fleet manager's window is not the same number.
//
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
import { publishFleetNotification, publishNotification } from '../realtime/publish.js';

// NINETY SECONDS, which is the brief's own figure for how long a re-plan storm
// lasts. It is long enough that the usual case — a dispatcher executing a
// recommendation and a technician accepting inside their forty-five-second
// offer window — has settled before the message is composed. It is not a
// measured number, and the honest failure mode is a re-plan that takes longer:
// the driver then gets one truthful message about an unsettled state ("Finding
// someone equipped for this") rather than a stale one, which is the right way
// for this to be wrong.
const REPLAN_COALESCE_MS = 90_000;

// PHASE 21 — FLEET NOTIFICATIONS ARE SUMMARIES, NOT SUB-MINUTE UPDATES. The
// phase brief is explicit about this and the reason is who is reading: a
// driver is standing beside the broken-down vehicle and ninety seconds is
// already a long time to wait for the truth. A fleet manager is at a desk
// watching a whole fleet; being told inside a minute that one van's crew was
// swapped is not useful to them and a re-plan storm across several vehicles
// in the same hour would otherwise read as the system being unstable rather
// than working. Ten minutes is long enough that a job re-planned three times
// inside it still produces one line on the fleet manager's screen. Not a
// measured number — the same honest admission REPLAN_COALESCE_MS makes.
const FLEET_STATE_CHANGE_COALESCE_MS = 10 * 60_000;

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

// Called from the SAME trigger points as `notifyDriverOfReplan` — a state
// change worth telling a driver about is a state change worth telling a
// fleet manager about too, just on a slower cadence. A walk-in job has no
// tenant and therefore no fleet manager to reach; the delivery function skips
// it rather than this one, which is what keeps every call site a one-line
// "and also notify the fleet" with no branch to remember.
export async function notifyFleetManagerOfStateChange(jobId: string, reason: string): Promise<void> {
  await enqueueDebounced(
    queues.notification,
    'fleet-state-change',
    `job:${jobId}:fleet-state-change`,
    { jobId, reason } satisfies NotificationJobData,
    FLEET_STATE_CHANGE_COALESCE_MS,
  );
}

export async function processNotification(job: Job): Promise<void> {
  const data = job.data as NotificationJobData;
  if (!data?.jobId) {
    await job.log('no jobId on this notification; nothing to send');
    return;
  }

  // The queue delivers at least once. Without this, a redelivery after a crash
  // writes a second copy of a message whose whole purpose was to be the only
  // one. Idempotency keyed on the QUEUE job id, which is the same id BullMQ
  // redelivers under — a driver notification and a fleet notification for the
  // same underlying job event still get two different queue jobs (two
  // `enqueueDebounced` calls, two dedupe keys), so keying on this rather than
  // on `data.jobId` cannot collapse the two kinds into one delivery.
  await runIdempotently('notification', job.id!, async () => {
    // ROUTED ON THE QUEUE JOB'S OWN NAME — 'driver-replan' or
    // 'fleet-state-change' — the label each enqueue call above gave it. Both
    // kinds share this one processor and this one queue rather than two,
    // because both are "wait, then describe where the job settled"; only the
    // window and the audience differ.
    if (job.name === 'fleet-state-change') {
      await deliverFleetStateChangeNotification(data);
      return;
    }
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
    // Same reasoning: any part run the crew made is behind them by the time a
    // coalesced notification goes out.
    sourcingPart: false,
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

// A short plain-language phrase per status, for the fleet manager's summary
// line ONLY. This is deliberately NOT driverNarrative.ts's vocabulary and does
// not reuse `headlineFor` — that file's header comment is explicit that its
// sentences are written for a driver reading under stress at a roadside, and
// a fleet manager reading a coalesced digest at a desk is a different reader
// with a different tolerance for a plain status word. Kept intentionally
// short: this is a summary line, not a narrative.
const FLEET_STATUS_PHRASE: Partial<Record<string, string>> = {
  EN_ROUTE: 'a technician is on the way',
  ON_SITE: 'a technician is on site',
  DIAGNOSING: 'being diagnosed',
  WORKING: 'being worked on',
  AWAITING_APPROVAL: 'paused, awaiting your driver’s approval on the cost',
  AWAITING_DESTINATION: 'awaiting a tow destination',
  TOWING: 'being towed',
  RESOLVED: 'resolved',
  UNSERVICEABLE: 'could not be resolved at the roadside',
  CANCELLED: 'cancelled',
};

async function deliverFleetStateChangeNotification(data: NotificationJobData): Promise<void> {
  // READ THE JOB NOW, same coalescing rule as the driver path: the state a
  // fleet manager reads about is the state the job is in by the time this
  // fires, not the trigger that started the ten-minute wait.
  const job = await prismaBase.job.findUnique({
    where: { id: data.jobId },
    select: {
      id: true,
      tenantId: true,
      status: true,
      vehicle: { select: { registration: true } },
    },
  });
  // A WALK-IN JOB HAS NO TENANT AND THEREFORE NO FLEET MANAGER. Not an error
  // — most jobs are exactly this — so this is the ordinary, silent case, not
  // a warning the way a driver-less job would be.
  if (!job?.tenantId) return;

  const recipients = await prismaBase.tenantMembership.findMany({
    where: { tenantId: job.tenantId, role: 'FLEET_MANAGER' },
    select: { userId: true },
  });
  if (recipients.length === 0) return;

  const phrase = FLEET_STATUS_PHRASE[job.status] ?? job.status;
  const body = `${job.vehicle.registration} is ${phrase}.`;
  const coalesceKey = `job:${job.id}:fleet-state-change`;
  const sentAt = new Date();

  // ONE ROW PER RECIPIENT — a tenant can have more than one fleet manager,
  // and `notifications.recipient_id` is one user, not a distribution list.
  // Idempotent the same way the driver path is (this whole delivery runs
  // inside `runIdempotently`), so a redelivery cannot write a second round.
  const created = await Promise.all(
    recipients.map((recipient) =>
      prismaBase.notification.create({
        data: {
          jobId: job.id,
          recipientId: recipient.userId,
          channel: 'SOCKET',
          title: 'Fleet update',
          body,
          coalesceKey,
          sentAt,
        },
        select: { id: true, createdAt: true },
      }),
    ),
  );

  // ONE SOCKET EMIT for every fleet manager in the tenant room, not one per
  // recipient — the room already fans out to everyone in it, and Socket.IO
  // rooms exist precisely so this is one call rather than a loop.
  const first = created[0]!;
  await publishFleetNotification(job.tenantId, {
    notificationId: first.id,
    jobId: job.id,
    title: 'Fleet update',
    body,
    at: first.createdAt.toISOString(),
  });
}
