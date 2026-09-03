// THE PRIORITY QUEUE'S ORDER — safety first, then SLA risk, then age.
//
// LEXICOGRAPHIC, NOT WEIGHTED, and this is invariant 4 appearing for the
// second time. src/engine/ranking.ts puts safety above the cost function when
// choosing WHO to send; this puts it above everything when choosing WHICH JOB
// a dispatcher looks at next. The argument is identical: a weighted score
// would let enough SLA pressure on a queue of ordinary jobs outrank one
// HIGH_RISK job, and there is no amount of ordinary urgency that should push a
// person standing on a live carriageway down the list.
//
// So the comparison is strictly tiered. Safety decides; only if two jobs share
// a safety level does SLA risk matter; only if they also tie on that does age.
//
// Pure — `now` is passed in, never read — so the same board always sorts the
// same way, and the ordering can be tested without a clock.

export const SAFETY_ORDER = ['HIGH_RISK', 'ELEVATED', 'NORMAL'] as const;
export type SafetyLevel = (typeof SAFETY_ORDER)[number];

export type QueuedJob = {
  id: string;
  safetyLevel: string;
  createdAt: Date;
  // Null when the job's contract carries no response commitment. Those jobs
  // have no SLA risk to speak of, which is different from having low risk —
  // see `slaRisk` below.
  slaResponseMinutes: number | null;
};

function safetyRank(level: string): number {
  const index = (SAFETY_ORDER as readonly string[]).indexOf(level);
  // An unrecognised level sorts as the MOST urgent, not the least. If a future
  // phase adds a level above HIGH_RISK and forgets this list, the failure is a
  // job being looked at too early rather than a genuinely dangerous job
  // sinking silently to the bottom.
  return index === -1 ? -1 : index;
}

// How much of the promised window this job has already used, as a fraction.
// Above 1 means the window has closed — deliberately NOT clamped, because "20%
// over" and "300% over" are different operational facts and a dispatcher
// working a backlog needs to see which is which.
//
// A job with no SLA returns 0: it cannot consume a window it does not have.
// That ranks it below every job that has one, which is the intended behaviour
// — an uncontracted job is not urgent by contract — but it is a policy choice
// rather than a mathematical necessity, so it is stated here.
export function slaRisk(job: QueuedJob, now: Date): number {
  if (job.slaResponseMinutes === null || job.slaResponseMinutes <= 0) return 0;
  const elapsedMinutes = (now.getTime() - job.createdAt.getTime()) / 60_000;
  return elapsedMinutes / job.slaResponseMinutes;
}

export function ageMinutes(job: QueuedJob, now: Date): number {
  return (now.getTime() - job.createdAt.getTime()) / 60_000;
}

// Three quarters of the promised window gone. Lives here, next to `slaRisk`,
// because it is a fact about the ordering rule rather than about any one
// screen: GET /queue counts at-risk jobs across the WHOLE pending set with it,
// and the console's SLA badge turns amber at the same figure, so the strip and
// the rows cannot disagree about what "at risk" means.
export const SLA_AT_RISK = 0.75;

export function countAtRisk(jobs: QueuedJob[], now: Date): number {
  return jobs.filter((job) => slaRisk(job, now) >= SLA_AT_RISK).length;
}

// Lower sorts first. The three keys are compared in order and the first
// difference wins — no key is ever traded against another.
export function compareForQueue(a: QueuedJob, b: QueuedJob, now: Date): number {
  const safety = safetyRank(a.safetyLevel) - safetyRank(b.safetyLevel);
  if (safety !== 0) return safety;

  // Higher risk first, so the sign is inverted relative to the others.
  const risk = slaRisk(b, now) - slaRisk(a, now);
  if (risk !== 0) return risk;

  const age = b.createdAt.getTime() - a.createdAt.getTime();
  if (age !== 0) return -age;

  // A deterministic tie-break, so two jobs identical on all three keys do not
  // swap places between renders.
  return a.id.localeCompare(b.id);
}

export function orderQueue<T extends QueuedJob>(jobs: T[], now: Date): T[] {
  return [...jobs].sort((a, b) => compareForQueue(a, b, now));
}
