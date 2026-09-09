// TYPES FOR A BROWSER MODULE THE TEST SUITE READS.
//
// Same arrangement as public/js/toastDecision.d.ts and for the same reason: the
// frontend is plain ES modules with no build step (CLAUDE.md), so nothing infers
// these. Hand-written for the two exports tests/unassignedReasons.test.ts
// imports, rather than `allowJs` across the whole project — which would start
// type-checking every panel against types nobody wrote.
//
// Only the unassigned-reason helpers are declared. `render` and the rest of the
// panel touch the DOM and are exercised in a browser, not here.

export type RejectionSummaryInput = { jobId: string; code: string };

export function describeUnassigned(
  unassignedJobIds: string[],
  rejected: RejectionSummaryInput[] | null | undefined,
): string;

export const REJECTION_PHRASES: Record<string, string>;
