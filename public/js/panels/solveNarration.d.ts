// TYPES FOR A BROWSER MODULE THE TEST SUITE READS. Same arrangement as
// plans.d.ts: the frontend is plain ES modules with no build step (CLAUDE.md),
// so nothing infers these.
//
// `stage` is deliberately loose. The real shape is the SolveStage union in
// src/engine/trace.ts, and restating it here would be a second copy that can
// disagree with the first — the thing this project keeps a test for rather than
// a duplicate type.

export type StageSentence = {
  text: string;
  lines: string[];
  emphasis?: boolean;
};

export function stageSentence(stage: unknown): StageSentence | null;
