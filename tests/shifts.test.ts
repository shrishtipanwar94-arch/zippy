// SHIFT COVERAGE — the seeded fleet is on duty at every hour of the day.
//
// THE BUG THIS EXISTS TO CATCH. The four bands cover 06:00 through to 06:00
// the following morning; nothing starts before 06:00. So the 00:00-06:00
// window of any day is covered only by the PREVIOUS day's night shift — and
// while each technician had exactly one shift row, keyed `shift-<id>`, a
// re-seed overwrote that previous night with tonight's. Seeding at 03:00
// therefore deleted the only shift covering 03:00 and left all 31 technicians
// off duty: `/solve` returned 10,248 options and rejected every one of them
// with NO_TECHNICIAN_ON_SHIFT while every capability matched.
//
// WHY THIS IS A PURE TEST AND DOES NOT SEED A DATABASE. The obvious version —
// run the seed, query the shifts, check the fleet is on duty — would only ever
// prove coverage at the one instant the suite happens to run. It would pass
// for eighteen hours a day and fail for six, so on any normal working schedule
// it would have gone green against the broken seed indefinitely. The property
// worth pinning is not "the fleet is on duty right now" but "the fleet is on
// duty at every hour, whatever time the seed ran", and that needs the seed's
// window arithmetic evaluated at 24 different seed times — which means calling
// the plan function, not reading rows back.
//
// `shiftPlan()` is the same function `seedTechnicians` writes from, so a
// change to the bands or the day offsets moves both together.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { shiftPlan, TECHNICIAN_COUNT } from '../prisma/seed/technicians.js';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// A seed run pinned to one instant: `hour` local time, on a fixed date.
function seedAt(hour: number): ReturnType<typeof shiftPlan> {
  vi.setSystemTime(new Date(2026, 7, 31, hour, 30, 0, 0)); // 31 Aug 2026, local
  return shiftPlan();
}

// Does anyone cover local `hour` on the day the seed ran?
function coversHour(windows: ReturnType<typeof shiftPlan>, hour: number): boolean {
  const instant = new Date(2026, 7, 31, hour, 30, 0, 0);
  return windows.some((window) => window.startsAt <= instant && instant <= window.endsAt);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the seeded fleet covers every hour of the day', () => {
  // THE REGRESSION, stated as its own case because 03:00 is the hour that was
  // actually broken and the one a future edit is most likely to break again.
  it('is on duty at 03:00 after a seed run at 03:00', () => {
    vi.useFakeTimers();
    expect(coversHour(seedAt(3), 3)).toBe(true);
  });

  it('covers all 24 hours whatever hour the seed itself ran at', () => {
    vi.useFakeTimers();

    for (const seedHour of HOURS) {
      const windows = seedAt(seedHour);
      const uncovered = HOURS.filter((hour) => !coversHour(windows, hour));

      expect(uncovered, `seeded at ${seedHour}:30, no technician covers hour(s)`).toEqual([]);
    }
  });

  // Coverage is not enough on its own: one technician on a 24-hour shift would
  // satisfy the test above and be nonsense. The bands are meant to overlap at
  // their edges, so every hour has more than a single point of failure.
  it('has at least two technicians on duty at every hour', () => {
    vi.useFakeTimers();
    const windows = seedAt(3);

    for (const hour of HOURS) {
      const instant = new Date(2026, 7, 31, hour, 30, 0, 0);
      const onDuty = new Set(
        windows
          .filter((window) => window.startsAt <= instant && instant <= window.endsAt)
          .map((window) => window.technicianId),
      );

      expect(onDuty.size, `only ${onDuty.size} technician(s) on duty at ${hour}:30`)
        .toBeGreaterThanOrEqual(2);
    }
  });

  it('writes two shifts per technician and no duplicate windows', () => {
    vi.useFakeTimers();
    const windows = seedAt(12);

    expect(windows).toHaveLength(TECHNICIAN_COUNT * 2);

    // Two rows for one technician must be two DIFFERENT days, or the second is
    // just an overwrite wearing a different id.
    const seen = new Set(
      windows.map((window) => `${window.technicianId} ${window.startsAt.toISOString()}`),
    );
    expect(seen.size).toBe(windows.length);
  });

  it('never writes a shift that ends before it starts', () => {
    vi.useFakeTimers();

    for (const seedHour of HOURS) {
      for (const window of seedAt(seedHour)) {
        expect(window.endsAt.getTime()).toBeGreaterThan(window.startsAt.getTime());
      }
    }
  });
});
