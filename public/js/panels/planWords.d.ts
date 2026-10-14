// TYPES FOR A BROWSER MODULE THE TEST SUITE READS. Same arrangement as
// rejectionWords.d.ts: the frontend is plain ES modules with no build step
// (CLAUDE.md), so nothing infers these.

export const PLAN_WORDS: Record<string, string>;

export function planWord(label: string): string;

export function describePlans(labels: string[] | null | undefined): string;
