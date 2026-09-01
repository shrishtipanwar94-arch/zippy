// STOCK IS A CLAIM, NOT A FACT.
//
// The number in `unit_stock.quantity` is what the system believes is in the
// back of a van. It is right until a technician uses a part without saying so,
// hands one to a colleague at a fuel stop, or finds the box was empty when
// they got to it. Nothing in the system can detect any of that — the only
// evidence we ever have is a human counting the shelf and telling us.
//
// So the honest model is not "how many" but "how many, and how long ago
// somebody looked". This file is that second half: it turns the AGE of the
// last confirmation into one of three words. The thresholds are passed in
// rather than read here, because this file has no imports on purpose — it is
// a pure function of two timestamps, which means Phase 19's feasibility filter
// can call it inside the solver without breaking invariant 10.
//
// Phase 19 is what makes this load-bearing: UNVERIFIED stock will count as
// UNAVAILABLE, failing closed, because assuming a part is present when it may
// not be produces a wasted dispatch and a driver who waits twice.

export type StockConfidence = 'VERIFIED' | 'AGEING' | 'UNVERIFIED';

export type StockAgeThresholds = {
  // Under this many minutes old, a count is VERIFIED.
  verifiedUnderMinutes: number;
  // Under this many minutes old, it is AGEING. At or past it, UNVERIFIED.
  ageingUnderMinutes: number;
};

export function stockConfidence(
  confirmedAt: Date | null,
  now: Date,
  thresholds: StockAgeThresholds,
): StockConfidence {
  // Never counted at all. Not "probably fine because we seeded it" — a number
  // nobody has ever checked is exactly the case this classification exists for.
  if (!confirmedAt) return 'UNVERIFIED';

  const minutes = minutesSince(confirmedAt, now);
  if (minutes < thresholds.verifiedUnderMinutes) return 'VERIFIED';
  if (minutes < thresholds.ageingUnderMinutes) return 'AGEING';
  return 'UNVERIFIED';
}

// A confirmation timestamped in the future is a phone with a wrong clock, not
// a fresher count. Clamping to zero means it reads as VERIFIED rather than as
// a negative age that would sort strangely — and the technician did just tap
// something, so "just counted" is the truthful reading.
export function minutesSince(confirmedAt: Date, now: Date): number {
  const elapsedMs = now.getTime() - confirmedAt.getTime();
  if (elapsedMs < 0) return 0;
  return Math.floor(elapsedMs / 60_000);
}
