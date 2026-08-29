// What one simulated job produced, and how a run of them reads in aggregate.
//
// Deliberately free of ids and wall-clock times: two runs of the same seed must
// print byte-identical output, and a cuid or a timestamp would break that. The
// job id stays in the database, where the SQL checks can find it.

import type { FaultCode } from '../domain/faults.js';
import type { SafetyLevel } from '@prisma/client';
import type { Situation } from './config.js';

export type SimulatedJob = {
  index: number;
  arrivalOffsetSeconds: number;
  trueFault: FaultCode;
  primaryComplaint: string;
  situation: Situation;
  safetyLevel: SafetyLevel;
  safetyReasonCodes: string[];
  questionsAsked: number;
  entropyStartBits: number;
  entropyEndBits: number;
  stopReason: string;
  topFault: string;
  requiredCapabilityCodes: string[];
};

export function diagnosisWasCorrect(job: SimulatedJob): boolean {
  return job.topFault === job.trueFault;
}

export type RunSummary = {
  jobs: number;
  meanQuestions: number;
  questionCounts: Record<number, number>;
  stopReasons: Record<string, number>;
  safetyLevels: Record<string, number>;
  topFaultAccuracy: number;
  meanEntropyStartBits: number;
  meanEntropyEndBits: number;
  jobsThatEndedLessCertain: number;
};

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function summarise(jobs: SimulatedJob[]): RunSummary {
  const questionCounts: Record<number, number> = {};
  for (const job of jobs) {
    questionCounts[job.questionsAsked] = (questionCounts[job.questionsAsked] ?? 0) + 1;
  }

  const correct = jobs.filter(diagnosisWasCorrect).length;

  return {
    jobs: jobs.length,
    meanQuestions: mean(jobs.map((job) => job.questionsAsked)),
    questionCounts,
    stopReasons: tally(jobs.map((job) => job.stopReason)),
    safetyLevels: tally(jobs.map((job) => job.safetyLevel)),
    topFaultAccuracy: jobs.length === 0 ? 0 : correct / jobs.length,
    meanEntropyStartBits: mean(jobs.map((job) => job.entropyStartBits)),
    meanEntropyEndBits: mean(jobs.map((job) => job.entropyEndBits)),
    // An honest counter, not a assertion: an unlucky sequence of answers CAN
    // leave intake less certain than the symptom report alone did. If this is
    // ever a large fraction, the likelihood tables are wrong.
    jobsThatEndedLessCertain: jobs.filter((job) => job.entropyEndBits > job.entropyStartBits).length,
  };
}
