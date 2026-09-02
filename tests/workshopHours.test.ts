// src/domain/workshopHours.ts — is a workshop open right now, in IST.

import { describe, expect, it } from 'vitest';
import { isWorkshopOpen, istDayOfWeekAndTime } from '../src/domain/workshopHours.js';
import type { WorkshopHoursRow } from '../src/domain/workshopHours.js';

const WEEKDAY_HOURS: WorkshopHoursRow[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  opens: '09:00',
  closes: '19:00',
  closed: dayOfWeek === 0, // Sunday
}));

const ALWAYS_OPEN: WorkshopHoursRow[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
  dayOfWeek,
  opens: '00:00',
  closes: '24:00',
  closed: false,
}));

describe('istDayOfWeekAndTime', () => {
  it('converts a UTC instant into IST day-of-week and HH:MM', () => {
    // 2026-06-15 is a Monday. 10:00 UTC = 15:30 IST, same day.
    const { dayOfWeek, hhmm } = istDayOfWeekAndTime(new Date('2026-06-15T10:00:00Z'));
    expect(dayOfWeek).toBe(1); // Monday
    expect(hhmm).toBe('15:30');
  });

  it('rolls the day forward across the IST offset', () => {
    // 19:00 UTC on a Sunday is 00:30 IST Monday.
    const { dayOfWeek, hhmm } = istDayOfWeekAndTime(new Date('2026-06-14T19:00:00Z')); // Sunday
    expect(dayOfWeek).toBe(1); // Monday in IST
    expect(hhmm).toBe('00:30');
  });
});

describe('isWorkshopOpen', () => {
  it('is open inside the window on a normal day', () => {
    // Monday 15:30 IST — inside 09:00-19:00.
    expect(isWorkshopOpen(WEEKDAY_HOURS, new Date('2026-06-15T10:00:00Z'))).toBe(true);
  });

  it('is closed before opening and at/after closing', () => {
    // Monday 08:00 IST.
    expect(isWorkshopOpen(WEEKDAY_HOURS, new Date('2026-06-15T02:30:00Z'))).toBe(false);
    // Monday 19:00 IST exactly — closing time is exclusive.
    expect(isWorkshopOpen(WEEKDAY_HOURS, new Date('2026-06-15T13:30:00Z'))).toBe(false);
  });

  it('is closed on the day marked closed regardless of the hour', () => {
    // Sunday 15:30 IST.
    const sunday = new Date('2026-06-14T10:00:00Z');
    expect(istDayOfWeekAndTime(sunday).dayOfWeek).toBe(0);
    expect(isWorkshopOpen(WEEKDAY_HOURS, sunday)).toBe(false);
  });

  it('is open at any hour for a round-the-clock workshop', () => {
    expect(isWorkshopOpen(ALWAYS_OPEN, new Date('2026-06-14T20:00:00Z'))).toBe(true); // Sunday night IST
    expect(isWorkshopOpen(ALWAYS_OPEN, new Date('2026-06-15T02:30:00Z'))).toBe(true); // Monday 08:00 IST
  });

  it('stays open in the last minute before midnight — the 24:00 close, not 23:59', () => {
    // 18:29 UTC = 23:59 IST. A `23:59` close would read shut here every day.
    expect(isWorkshopOpen(ALWAYS_OPEN, new Date('2026-06-15T18:29:30Z'))).toBe(true);
  });

  it('treats a missing row for today as closed rather than open', () => {
    const onlyMonday: WorkshopHoursRow[] = [{ dayOfWeek: 1, opens: '09:00', closes: '19:00', closed: false }];
    // Tuesday.
    expect(isWorkshopOpen(onlyMonday, new Date('2026-06-16T10:00:00Z'))).toBe(false);
  });
});
