// THE SOLVE TRACE — what the solver did, stage by stage, while it is doing it.
//
// Every number below was already computed by solve.ts and then thrown away
// behind a single summary line. This file gives those numbers a shape and a
// moment, so a caller that wants to watch a solve happen can, and one that
// does not is unaffected.
//
// FACTS HERE, SENTENCES IN THE CONSOLE. Nothing in this file writes prose. The
// wording lives in public/js/panels/solveNarration.js, next to the rejection
// phrases it has to agree with — one vocabulary for the decision, in the place
// a person reads it. An engine that wrote its own sentences would give the
// console a second vocabulary and the two would drift apart within a phase.
//
// INVARIANT 2 IS INTACT. `StageReporter` is a plain callback, not a writer: the
// engine still imports nothing from prisma or redis, still returns the same
// plans for the same snapshot, and a run with a reporter attached produces
// exactly the plans a run without one produces. The evaluation harness passes
// none, so a measured run is unchanged.

import type { SafetyLevelSnapshot } from './candidates.js';
import type { RejectionCode } from './feasibility.js';

// ONE SAFETY BAND'S HANDOVER — invariant 4 as an arithmetic fact.
//
// `unitsOffered` is how many units this band could choose from, and
// `unitsLeftBelow` is what it left for the bands under it. Those two numbers
// are the lexicographic ordering made visible: no amount of cost can move a
// unit upward across them, because by the time the band below is solved the
// unit is already gone.
export type SafetyBandTrace = {
  level: SafetyLevelSnapshot;
  jobCount: number;
  assignedCount: number;
  unitsOffered: number;
  unitsLeftBelow: number;
};

export type SolveStage =
  | {
      stage: 'PENDING';
      elapsedMs: number;
      jobCount: number;
      unitCount: number;
      availableUnitCount: number;
      technicianCount: number;
    }
  | { stage: 'CANDIDATES'; elapsedMs: number; jobCount: number; optionCount: number }
  | {
      stage: 'FEASIBILITY';
      elapsedMs: number;
      optionCount: number;
      feasibleCount: number;
      rejectedCount: number;
      // Rejected OPTIONS per code, across every job — not jobs. Twenty-three
      // units all off shift for one job is twenty-three here.
      rejectedByCode: Record<string, number>;
    }
  | { stage: 'SAFETY_BANDS'; elapsedMs: number; planLabel: string; bands: SafetyBandTrace[] }
  | {
      stage: 'COST';
      elapsedMs: number;
      termCount: number;
      planLabels: string[];
      zonePartitioned: boolean;
    }
  | {
      stage: 'OUTCOME';
      elapsedMs: number;
      planLabel: string;
      assignedCount: number;
      unassignedCount: number;
      // One entry per unassigned JOB, under its single dominant reason — see
      // `countUnassignedByReason`. Adds up to `unassignedCount`, so the console
      // can read it as "six of the ten".
      unassignedByReason: Record<string, number>;
    }
  | { stage: 'DONE'; elapsedMs: number; wallClockMs: number; timedOut: boolean; unplannedCount: number };

export type StageReporter = (stage: SolveStage) => void;

// A JOB THAT LOST A UNIT TO A HIGHER-PRIORITY JOB WAS NOT REFUSED BY ANYTHING,
// and this is the bucket that says so rather than inventing a feasibility code
// for it. Contention is a different fact from infeasibility and the console
// words it differently.
export const CONTENTION_REASON = 'CONTENTION';

export function countRejectionsByCode(rejections: { code: RejectionCode }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const rejection of rejections) {
    counts[rejection.code] = (counts[rejection.code] ?? 0) + 1;
  }
  return counts;
}

// SUMMED ACROSS ZONE PARTITIONS. A partitioned solve runs the safety bands once
// per zone, so "the high-risk round" is several rounds that happen to be
// separate matrices. Reporting them separately would put the same band on
// screen three times with numbers a reader cannot add up; summing them says the
// true thing — this many high-risk jobs were matched first, out of this many
// units — without pretending the board was one matrix.
export function addBand(
  totals: Map<SafetyLevelSnapshot, SafetyBandTrace>,
  band: SafetyBandTrace,
): void {
  const existing = totals.get(band.level);
  if (!existing) {
    totals.set(band.level, { ...band });
    return;
  }
  existing.jobCount += band.jobCount;
  existing.assignedCount += band.assignedCount;
  existing.unitsOffered += band.unitsOffered;
  existing.unitsLeftBelow += band.unitsLeftBelow;
}

// WHY EACH UNASSIGNED JOB IS STILL WAITING — one reason per job, not one per
// refused option. Twenty-three units all off shift for one job is one job here,
// which is what makes the counts add up to the unassigned total.
//
// The dominant reason is the most common code among that job's rejections, ties
// broken by name so the sentence is stable between two runs of the same board.
// public/js/panels/plans.js does the same tally in the browser, over the plan
// card's own plan; this one is about the recommended plan and has to exist
// server-side because the stage line is written before the report is.
export function countUnassignedByReason(
  unassignedJobIds: string[],
  rejections: { jobId: string; code: RejectionCode }[],
): Record<string, number> {
  const codesByJob = new Map<string, string[]>();
  for (const jobId of unassignedJobIds) codesByJob.set(jobId, []);
  for (const rejection of rejections) codesByJob.get(rejection.jobId)?.push(rejection.code);

  const counts: Record<string, number> = {};
  for (const codes of codesByJob.values()) {
    const reason = dominantCode(codes) ?? CONTENTION_REASON;
    counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return counts;
}

function dominantCode(codes: string[]): string | null {
  const counts = countRejectionsByCode(codes.map((code) => ({ code: code as RejectionCode })));

  let best: string | null = null;
  let bestCount = 0;
  for (const code of Object.keys(counts).sort()) {
    const count = counts[code] ?? 0;
    if (count > bestCount) {
      best = code;
      bestCount = count;
    }
  }
  return best;
}
