// THE FLEET DASHBOARD'S NUMBERS, COMPUTED FROM A PLAIN LIST OF INCIDENTS —
// SLA met %, current exposure, mean resolution time, spend, and which jobs
// are active right now. Pure; src/commit/fleetIncidents.ts fetches the rows,
// this file only counts them.
//
// "THIS MONTH" IS A CALENDAR MONTH IN UTC. Every timestamp in this project is
// stored and reasoned about in UTC (driver-facing IST clock strings are a
// display-layer translation in driverNarrative.ts, not how the backend keeps
// time), so a month boundary drawn in UTC is the one that agrees with every
// other date comparison in the codebase. It can read a fleet manager in
// Bengaluru a report that rolled over at 5:30am local time rather than
// midnight — a real but minor honesty gap, recorded rather than hidden.

import { slaOutcomeFor } from './fleetSlaOutcome.js';
import type { SlaOutcome } from './fleetSlaOutcome.js';

// The shape src/commit/fleetIncidents.ts produces. Repeated here rather than
// imported so this file stays free of any dependency on Prisma's generated
// types — the same zero-imports discipline src/engine follows, applied to a
// domain file that happens to sit next to a commit-layer one with a similar
// name.
export type Incident = {
  jobId: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  responseMinutes: number | null;
  breachPenaltyPaise: number;
  arrivedAt: Date | null;
  approvedTotalPaise: number | null;
};

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['RESOLVED', 'UNSERVICEABLE', 'CANCELLED']);

export function isActive(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function isThisMonth(at: Date, monthStart: Date, now: Date): boolean {
  return at >= monthStart && at <= now;
}

// ---------------------------------------------------------------------------
// SLA MET %, this month.
//
// THE DENOMINATOR IS DECIDED JOBS, NOT ALL JOBS. A job raised an hour ago,
// still comfortably inside its window, is neither a success nor a failure yet
// — counting it either way would make the percentage swing on jobs that are
// still in progress rather than on jobs whose outcome is a fact. Excluding
// UNDECIDED and NOT_APPLICABLE from both halves of the fraction is the same
// move evaluation/metrics.ts makes computing mean resolution time only over
// jobs that finished.
export type SlaMetSummary = {
  metPercent: number | null;
  decidedCount: number;
  metCount: number;
};

export function slaMetSummary(incidents: Incident[], now: Date): SlaMetSummary {
  const monthStart = startOfMonthUtc(now);

  let met = 0;
  let decided = 0;

  for (const incident of incidents) {
    if (!isThisMonth(incident.createdAt, monthStart, now)) continue;

    const outcome = slaOutcomeFor({
      createdAt: incident.createdAt,
      responseMinutes: incident.responseMinutes,
      arrivedAt: incident.arrivedAt,
      now,
    });
    if (outcome === 'UNDECIDED' || outcome === 'NOT_APPLICABLE') continue;

    decided += 1;
    if (outcome === 'MET') met += 1;
  }

  return {
    metPercent: decided === 0 ? null : Math.round((met / decided) * 1000) / 10,
    decidedCount: decided,
    metCount: met,
  };
}

// ---------------------------------------------------------------------------
// CURRENT EXPOSURE, in paise — what this fleet would be invoiced today if
// every contract breach still open were settled right now.
//
// SCOPED TO ACTIVE INCIDENTS ON PURPOSE, not to this month. "Current" means
// live risk, and a breach on a job that has already been resolved or
// cancelled is a fact for the invoice, not something still open for anyone to
// act on — it is exactly the same active/terminal line the dashboard's own
// "active incidents" list draws, so the two numbers describe the same set of
// jobs from two angles.
//
// A BOOLEAN "ALREADY BREACHED", NOT A PROBABILITY. The cost function's
// contractSlaExposure (src/engine/cost.ts) prices a DISPATCH DECISION under
// uncertainty about an option that has not happened yet, and needs a
// candidate's estimated arrival time to do that — an input this dashboard does
// not have and should not manufacture. What it can say honestly is simpler and
// no less real: has this incident's window already closed with nobody there.
// `slaOutcomeFor` answers exactly that, with the same deadline arithmetic.
export function currentExposurePaise(incidents: Incident[], now: Date): number {
  let total = 0;
  for (const incident of incidents) {
    if (!isActive(incident.status)) continue;

    const outcome = slaOutcomeFor({
      createdAt: incident.createdAt,
      responseMinutes: incident.responseMinutes,
      arrivedAt: incident.arrivedAt,
      now,
    });
    if (outcome === 'BREACHED') total += incident.breachPenaltyPaise;
  }
  return total;
}

// ---------------------------------------------------------------------------
// MEAN RESOLUTION TIME, this month — over jobs that actually resolved, the
// same "only jobs that finished have a resolution time" rule everywhere else
// in this codebase applies to that phrase.
export type ResolutionSummary = { meanMinutes: number | null; resolvedCount: number };

export function meanResolutionSummary(incidents: Incident[], now: Date): ResolutionSummary {
  const monthStart = startOfMonthUtc(now);

  const minutes: number[] = [];
  for (const incident of incidents) {
    if (incident.status !== 'RESOLVED' || !incident.resolvedAt) continue;
    if (!isThisMonth(incident.createdAt, monthStart, now)) continue;
    minutes.push((incident.resolvedAt.getTime() - incident.createdAt.getTime()) / 60_000);
  }

  if (minutes.length === 0) return { meanMinutes: null, resolvedCount: 0 };

  const mean = minutes.reduce((sum, value) => sum + value, 0) / minutes.length;
  return { meanMinutes: Math.round(mean * 10) / 10, resolvedCount: minutes.length };
}

// ---------------------------------------------------------------------------
// SPEND, this month — what the work was worth on jobs that finished this
// month, summed from the SAME number the ledger books at completion
// (src/commit/estimates.ts's `approvedTotalFor`; see
// src/commit/fleetIncidents.ts for why this reads the estimate directly
// rather than the ledger account it eventually posts to). Scoped to jobs that
// RESOLVED this month — the identical filter meanResolutionSummary uses —
// so the two numbers on the dashboard describe the same set of incidents.
export function spendPaiseThisMonth(incidents: Incident[], now: Date): number {
  const monthStart = startOfMonthUtc(now);

  let total = 0;
  for (const incident of incidents) {
    if (incident.status !== 'RESOLVED' || !incident.resolvedAt) continue;
    if (!isThisMonth(incident.createdAt, monthStart, now)) continue;
    total += incident.approvedTotalPaise ?? 0;
  }
  return total;
}

// Re-exported so a caller needing the raw outcome (the per-vehicle history
// view marks each incident MET/BREACHED/⋯ individually) does not import from
// two modules to get the whole picture.
export type { SlaOutcome };
export { slaOutcomeFor };
