// WHAT A TECHNICIAN IS OWED — the read side of the ledger they never saw.
//
// Phase 15c built the whole earnings model and Phase 22b built the rail that
// pays it out. Neither built a way for the person earning the money to look at
// it: `technicianBalance` existed in src/commit/ledger.ts with no route, and the
// technician's page had no view of it at all. That was the largest single gap
// the Phase 22b audit found.
//
// THE NEGATIVE BALANCE IS THE INTERESTING CASE, and it is why this is a
// statement rather than a number. A technician who takes cash from a driver is
// holding money that is mostly not theirs: the customer's debt is discharged
// and their own claim on the platform drops by the FULL amount collected, so
// their balance goes negative by roughly the platform's commission
// (src/domain/ledger.ts, cashCollectionLines). Nothing is "taken back" — no
// rail will pull money out of somebody's account and nobody agreed to that —
// the debt simply nets against what they earn next, because a balance is a SUM
// over an append-only log.
//
// Somebody seeing a negative number on their phone with no explanation would
// reasonably think they had been charged. So the API returns the standing, the
// entries that produced it, and what the next payout run will do about it.
//
// NOTHING IS COMPUTED THAT THE LEDGER DOES NOT ALREADY SAY. The balance is the
// same aggregate `runPayoutBatch` reads, and the decision is the same pure
// `payoutDecision` the run itself applies — a second opinion here would be a
// second answer to "will I be paid tomorrow".

import type { PrismaClient } from '@prisma/client';
import { config } from '../infra/config.js';
import { payoutDecision, technicianAccountCode } from '../domain/ledger.js';
import { technicianBalance } from './ledger.js';

const ENTRY_LIMIT = 20;

export type EarningsStatement = {
  balancePaise: number;
  minimumPaise: number;
  // What today has been worth so far, and over how many jobs. The balance
  // answers "what will I be paid" and can legitimately be negative; this
  // answers "was today any good", which is the question somebody sitting in a
  // van between jobs actually has.
  todayPaise: number;
  jobsToday: number;
  // PAY | HOLD_BELOW_MINIMUM | CARRY_DEBT, straight from the domain rule.
  standing: string;
  // One sentence a person can act on, rather than a status word.
  explanation: string;
  entries: { at: string; memo: string; amountPaise: number }[];
  pendingPayouts: { reference: string | null; amountPaise: number; status: string }[];
};

export async function earningsStatementFor(
  db: PrismaClient,
  technicianId: string,
): Promise<EarningsStatement> {
  const minimumPaise = config.PAYOUT_MINIMUM_PAISE;
  const [balancePaise, entries, pendingPayouts, today] = await Promise.all([
    technicianBalance(db, technicianId),
    recentEntries(db, technicianId),
    db.payout.findMany({
      where: { technicianId, status: { in: ['PENDING', 'SENT'] } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { amountPaise: true, status: true, batch: { select: { reference: true } } },
    }),
    earnedToday(db, technicianId, new Date()),
  ]);

  const decision = payoutDecision(balancePaise, minimumPaise);

  return {
    balancePaise,
    minimumPaise,
    // TODAY, ON THE FRONT OF THE PHONE. The balance is a running position and
    // answers a different question — "what will I be paid" — which is why it can
    // legitimately be negative. What a technician actually wants at a glance
    // between jobs is what today has been worth so far, and that figure was
    // reachable only by opening a disclosure and reading a list.
    todayPaise: today.amountPaise,
    jobsToday: today.jobs,
    standing: decision.outcome,
    explanation: explain(decision.outcome, balancePaise, minimumPaise),
    entries,
    pendingPayouts: pendingPayouts.map((payout) => ({
      reference: payout.batch?.reference ?? null,
      amountPaise: payout.amountPaise,
      status: payout.status,
    })),
  };
}

// THE THREE OUTCOMES, IN THE SECOND PERSON. The wording for CARRY_DEBT is the
// one that matters: it has to say "netted against what you earn next" and never
// anything that sounds like money being taken.
function explain(outcome: string, balancePaise: number, minimumPaise: number): string {
  if (outcome === 'CARRY_DEBT') {
    return (
      'You are holding cash that is not all yours — the platform’s share of jobs ' +
      'you collected on. Nothing will be taken from your account. It comes off ' +
      'the top of what you earn next.'
    );
  }
  if (outcome === 'HOLD_BELOW_MINIMUM') {
    const shortfall = minimumPaise - balancePaise;
    return `This rolls over to the next run — payouts start at ${rupees(minimumPaise)}, so you need ${rupees(shortfall)} more.`;
  }
  return 'This is due in the next payout run.';
}

function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

// The entries behind the number, so a technician can see WHICH job moved it.
// Read straight off the append-only log — there is no balance column and there
// must not be one.
// WHAT TODAY HAS BEEN WORTH. Credits only: a commission deducted from a cash
// job is a real ledger movement but it is not something the technician EARNED
// today, and netting it here would make a good day look like a bad one.
//
// The day boundary is IST, the same fixed offset the rest of the product
// reasons about local time with (src/domain/driverNarrative.ts) — a technician
// finishing at 1am should see that job on the day they worked it, not on the
// day UTC thinks it is.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

function startOfIstDay(now: Date): Date {
  const local = new Date(now.getTime() + IST_OFFSET_MINUTES * 60 * 1000);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST_OFFSET_MINUTES * 60 * 1000);
}

async function earnedToday(
  db: PrismaClient,
  technicianId: string,
  now: Date,
): Promise<{ amountPaise: number; jobs: number }> {
  const account = await db.ledgerAccount.findUnique({
    where: { code: technicianAccountCode(technicianId) },
    select: { id: true },
  });
  if (!account) return { amountPaise: 0, jobs: 0 };

  const entries = await db.ledgerEntry.findMany({
    where: {
      accountId: account.id,
      eventTime: { gte: startOfIstDay(now) },
      amountPaise: { gt: 0 },
    },
    select: { amountPaise: true, jobId: true },
  });

  const jobs = new Set(entries.map((entry) => entry.jobId).filter((id) => id !== null));
  return {
    amountPaise: entries.reduce((total, entry) => total + entry.amountPaise, 0),
    jobs: jobs.size,
  };
}

async function recentEntries(db: PrismaClient, technicianId: string) {
  const account = await db.ledgerAccount.findUnique({
    where: { code: technicianAccountCode(technicianId) },
    select: { id: true },
  });
  if (!account) return [];

  const entries = await db.ledgerEntry.findMany({
    where: { accountId: account.id },
    orderBy: { eventTime: 'desc' },
    take: ENTRY_LIMIT,
    select: { amountPaise: true, memo: true, eventTime: true },
  });

  return entries.map((entry) => ({
    at: entry.eventTime.toISOString(),
    memo: entry.memo ?? 'ledger entry',
    amountPaise: entry.amountPaise,
  }));
}
