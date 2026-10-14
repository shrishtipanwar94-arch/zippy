// TYPES FOR A BROWSER MODULE THE TEST SUITE READS. See solveNarration.d.ts for
// why `decision` is loose: its real shape is GET /jobs/:id/decision's response,
// which src/api/console.ts builds and no type here should restate.

export type DecisionNarration = {
  title: string;
  paragraphs: string[];
  override: string | null;
};

export function narrateDecision(decision: unknown): DecisionNarration | null;
