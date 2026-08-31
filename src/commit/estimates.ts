// THE ESTIMATE, AND THE DRIVER'S ANSWER TO IT.
//
// An estimate is built AFTER DIAGNOSIS, because before that the system only
// has a probability distribution and quoting a price off a guess is how a
// customer is told ₹640 and charged ₹2,340. The technician has now opened the
// car; this prices what they found.
//
// EVERY PRICE COMES FROM THE JOB'S PINNED LIST, AS AT ITS CREATION INSTANT —
// `job.priceListId` and `job.createdAt`, never the clock (stage 1,
// src/pricing/priceList.ts). That is what makes "a price list expiring
// mid-job" a non-event and it is why nothing here takes a date parameter.
//
// THE RE-APPROVAL LOOP is the part worth reading. A revision that exceeds what
// the driver approved by more than the tolerance does not proceed hopefully:
// the job moves to AWAITING_APPROVAL, which the technician's status ladder
// cannot advance out of (src/domain/jobLadder.ts has no rank for it), so the
// pause is structural rather than a check somebody has to remember. Only an
// approval moves it back.
//
// WHAT IS NOT HERE, deliberately: no payment, no ledger, no payouts, and no
// contract coverage. The estimate is what the work costs; who ends up paying
// which part of it is settlement, and settlement is a later stage.

import type { Prisma, PrismaClient, Role } from '@prisma/client';
import { config } from '../infra/config.js';
import { logger } from '../infra/logger.js';
import { isFaultCode, labourCodeForFault, partSkusForFault } from '../domain/faults.js';
import type { FaultCode } from '../domain/faults.js';
import { resolveMinutes } from '../engine/durations.js';
import { priceCallout, priceLabour, priceParts, priceTow, totalOf } from '../domain/pricing.js';
import type { PricedLine } from '../domain/pricing.js';
import { reapprovalDecision } from '../domain/estimateApproval.js';
import { calloutRate, labourRate, partRate, towRate } from '../pricing/rateCard.js';
import { appendJobEvent } from '../intake/events.js';
import { runPublishingTransaction } from '../realtime/transaction.js';

export type BuildEstimateInput = {
  jobId: string;
  // Set when the job needs moving. There is no tow line without a distance,
  // because a tow is metered and nothing here may invent one — the workshop a
  // job is towed to is chosen at Phase 22, and until then a caller that knows
  // the distance passes it and one that does not gets no tow line.
  towKilometres?: number;
  actor: { role: Role; id: string | null };
};

export type BuildEstimateOutcome =
  | {
      outcome: 'ISSUED';
      estimateId: string;
      totalPaise: number;
      // What this revision means for the driver: the first ask, a pause for a
      // fresh answer, or something the existing approval already covers.
      approval: 'NEEDS_FIRST_APPROVAL' | 'NEEDS_REAPPROVAL' | 'COVERED';
      paused: boolean;
    }
  // No pinned price list, or the list cannot price this fault at all.
  | { outcome: 'CANNOT_PRICE'; reason: string }
  // One is already out with the driver. Two live estimates is two answers to
  // wait for and no way to say which one the approval was about.
  | { outcome: 'ALREADY_AWAITING'; estimateId: string }
  | { outcome: 'NOT_FOUND' };

export async function buildEstimate(
  db: PrismaClient,
  input: BuildEstimateInput,
): Promise<BuildEstimateOutcome> {
  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: {
      id: true,
      status: true,
      priceListId: true,
      createdAt: true,
      onHighway: true,
      faultHypotheses: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { topFault: true },
      },
    },
  });
  if (!job) return { outcome: 'NOT_FOUND' };

  if (!job.priceListId) {
    // Stage 1 lets a job be created with no list in force rather than blocking
    // a stranded driver. This is where that bill comes due, and it is a
    // degraded state an operator can see rather than a crash.
    return { outcome: 'CANNOT_PRICE', reason: 'this job has no pinned price list' };
  }

  const outstanding = await db.estimate.findFirst({
    where: { jobId: job.id, status: 'SENT' },
    select: { id: true },
  });
  if (outstanding) return { outcome: 'ALREADY_AWAITING', estimateId: outstanding.id };

  const topFault = job.faultHypotheses[0]?.topFault;
  if (!topFault || !isFaultCode(topFault)) {
    return { outcome: 'CANNOT_PRICE', reason: 'this job has no diagnosis to price' };
  }

  const lines = await priceTheWork(db, {
    fault: topFault,
    priceListId: job.priceListId,
    at: job.createdAt,
    onHighway: job.onHighway ?? false,
    towKilometres: input.towKilometres,
  });
  if (lines.length === 0) {
    return { outcome: 'CANNOT_PRICE', reason: 'the pinned price list carries none of these rates' };
  }

  const totalPaise = totalOf(lines);
  const approvedTotalPaise = await approvedTotalFor(db, job.id);
  const decision = reapprovalDecision({
    approvedTotalPaise,
    revisedTotalPaise: totalPaise,
    toleranceBps: config.ESTIMATE_REAPPROVAL_TOLERANCE_BPS,
  });

  // A revision the existing approval already covers does not stop the job. The
  // driver agreed to spend at least this much, and pausing to say "it is a
  // little cheaper than we thought" helps nobody.
  const paused = decision.outcome !== 'COVERED';

  const estimateId = await runPublishingTransaction(db, async (tx) => {
    const estimate = await tx.estimate.create({
      data: {
        jobId: job.id,
        priceListId: job.priceListId,
        // COVERED estimates are APPROVED on arrival: they inherit the answer
        // the driver already gave, and leaving them SENT would be asking a
        // question nobody needs to answer.
        status: paused ? 'SENT' : 'APPROVED',
        subtotalPaise: totalPaise,
        // Tax is a column this stage does not fill. GST is named as deliberate
        // headroom in the phase brief and is not built.
        taxPaise: 0,
        totalPaise,
        lines: {
          create: lines.map((line) => ({
            kind: line.kind,
            description: line.description,
            quantity: line.quantity,
            unitPricePaise: line.unitPricePaise,
            amountPaise: line.amountPaise,
            refId: line.refId,
          })),
        },
      },
      select: { id: true },
    });

    if (paused) await pauseForApproval(tx, job.id);

    await appendJobEvent(tx, {
      jobId: job.id,
      eventType: 'ESTIMATE_ISSUED',
      payload: {
        estimateId: estimate.id,
        totalPaise,
        approvedTotalPaise,
        approval: decision.outcome,
        paused,
        ...(decision.outcome === 'NEEDS_REAPPROVAL'
          ? { allowancePaise: decision.allowancePaise, overByPaise: decision.overBy }
          : {}),
      },
      actorRole: input.actor.role,
      actorId: input.actor.id,
    });

    return estimate.id;
  });

  return { outcome: 'ISSUED', estimateId, totalPaise, approval: decision.outcome, paused };
}

// WORK STOPS HERE. Conditional on the job being somewhere work could be
// happening, so an estimate raised against a cancelled or already-resolved job
// cannot drag it back into an open state.
const PAUSABLE_STATUSES = ['ON_SITE', 'DIAGNOSING', 'WORKING'] as const;

async function pauseForApproval(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  await tx.job.updateMany({
    where: { id: jobId, status: { in: [...PAUSABLE_STATUSES] } },
    data: { status: 'AWAITING_APPROVAL', version: { increment: 1 } },
  });
}

// The highest total the driver has actually said yes to. Null when they have
// approved nothing, which is what makes the first estimate always an ask.
//
// The MAXIMUM rather than the latest, because a revision that came in cheaper
// and was approved does not shrink what the driver has agreed to spend — they
// consented to a ceiling, and lowering it silently would make the next small
// overrun re-ask for no reason.
//
// Typed on `TransactionClient` so the one definition serves both callers: the
// estimate builder asks before opening a transaction, and the response path
// asks inside one. A `PrismaClient` satisfies that type, so there is no second
// copy differing only in its parameter.
export async function approvedTotalFor(
  tx: Prisma.TransactionClient,
  jobId: string,
): Promise<number | null> {
  const approved = await tx.estimate.aggregate({
    where: { jobId, status: 'APPROVED' },
    _max: { totalPaise: true },
  });
  return approved._max.totalPaise ?? null;
}

// ---------------------------------------------------------------------------
// PRICING THE WORK. Parts, labour, a tow if there is one, and the callout.
// Every lookup is against the job's pinned list at the job's creation instant.

async function priceTheWork(
  db: PrismaClient,
  input: {
    fault: FaultCode;
    priceListId: string;
    at: Date;
    onHighway: boolean;
    towKilometres?: number;
  },
): Promise<PricedLine[]> {
  const lines: PricedLine[] = [];

  for (const sku of partSkusForFault(input.fault)) {
    const part = await db.part.findUnique({ where: { sku }, select: { id: true } });
    if (!part) {
      logger.warn({ sku }, 'a fault names a part SKU the catalogue does not have');
      continue;
    }
    const rate = await partRate(db, {
      priceListId: input.priceListId,
      partId: part.id,
      at: input.at,
    });
    // A part the pinned list does not price is skipped rather than guessed at.
    // The technician revising the estimate is the mechanism for anything the
    // catalogue could not supply.
    if (rate) lines.push(priceParts(rate, 1));
  }

  const labour = await labourRate(db, {
    priceListId: input.priceListId,
    code: labourCodeForFault(input.fault),
    at: input.at,
  });
  if (labour) {
    // The same duration model the cost function reasons about, so what a job
    // is QUOTED and what the solver EXPECTED it to take cannot drift apart.
    const hours = Number((resolveMinutes(input.fault) / 60).toFixed(2));
    lines.push(priceLabour(labour, hours));
  }

  if (input.towKilometres !== undefined) {
    const tow = await towRate(db, {
      priceListId: input.priceListId,
      towType: 'FLATBED',
      at: input.at,
    });
    if (tow) lines.push(priceTow(tow, input.towKilometres));
  }

  // Highway callouts cost more because reaching one does. Derived from the
  // job's own `on_highway`, which stage 3 of Phase 3 derives from the reported
  // road position — one fact, one home.
  const callout = await calloutRate(db, {
    priceListId: input.priceListId,
    serviceType: input.onHighway ? 'HIGHWAY' : 'STANDARD',
    at: input.at,
  });
  if (callout) lines.push(priceCallout(callout));

  return lines;
}
