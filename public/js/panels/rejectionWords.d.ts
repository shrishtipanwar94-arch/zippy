// TYPES FOR A BROWSER MODULE THE TEST SUITE READS. Same arrangement as
// plans.d.ts and toastDecision.d.ts: the frontend is plain ES modules with no
// build step (CLAUDE.md), so nothing infers these.

export const REJECTION_PHRASES: Record<string, string>;
export const CREW_REJECTION_PHRASES: Record<string, string>;

export function describeCrewRejections(
  countsByCode: Record<string, number> | null | undefined,
): string[];

export const CONTENTION_PHRASE: string;

export function describeJobRejections(
  countsByCode: Record<string, number> | null | undefined,
): string[];
