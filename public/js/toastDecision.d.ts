// TYPES FOR A BROWSER MODULE THE TEST SUITE READS.
//
// The frontend is plain ES modules with no build step (CLAUDE.md), so there is
// no compiler pass over public/js to infer these. This file exists purely so
// tests/toast.test.ts can import the decision and typecheck — it is the type
// contract for one small module, hand-written, rather than `allowJs` across the
// whole project, which would start type-checking every panel against types
// nobody wrote.

export type ToastState = {
  pendingCount: number;
  resultKey: string | null;
  primed: boolean;
};

export type ToastInput = {
  pendingCount: number;
  resultKey: string | null;
  step?: string | null;
};

export type Toast = { kind: 'sent' | 'queued'; step: string | null };

export function decideToast(
  previous: ToastState,
  next: ToastInput,
): { toast: Toast | null; next: ToastState };

export function initialToastState(): ToastState;

export function resultKeyOf(
  result: { step?: string | null; outcome?: string | null; detail?: string | null } | null,
): string | null;
