// IS A WORKSHOP OPEN RIGHT NOW — read against `WorkshopHours`, in IST.
//
// A workshop closed for the night is not a candidate to tow to, whatever its
// authorisation and P(accept) say — this runs BEFORE either of those in
// destination selection (src/engine/destinationSelection.ts) for exactly the
// reason a technician's shift window runs before everything else in
// feasibility.ts: a fact about WHEN, not about WHETHER a match would be good.
//
// NO OVERNIGHT WINDOWS. Every seeded workshop's hours are same-day
// (`09:00`-`19:00`, or `00:00`-`23:59` for the two round-the-clock ones), so a
// simple string comparison of `opens <= now < closes` is correct. A workshop
// open across midnight (`22:00`-`06:00`) would need the comparison split in
// two, and nothing in this project's data needs that yet — recorded as a gap,
// not silently handled wrong.
//
// Pure. No database, no clock — `at` is passed in.

const IST_OFFSET_MINUTES = 5 * 60 + 30; // see workshopAcceptance.ts's own copy

export type WorkshopHoursRow = {
  dayOfWeek: number; // 0 = Sunday, matching JS Date#getDay and the seed
  opens: string; // "HH:MM"
  closes: string; // "HH:MM"
  closed: boolean;
};

export function istDayOfWeekAndTime(at: Date): { dayOfWeek: number; hhmm: string } {
  const ist = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return { dayOfWeek: ist.getUTCDay(), hhmm: `${hh}:${mm}` };
}

export function isWorkshopOpen(hours: WorkshopHoursRow[], at: Date): boolean {
  const { dayOfWeek, hhmm } = istDayOfWeekAndTime(at);
  const row = hours.find((candidate) => candidate.dayOfWeek === dayOfWeek);
  // No row for today at all is the same as closed — a workshop with an
  // incomplete hours table should not be treated as always open.
  if (!row || row.closed) return false;
  return hhmm >= row.opens && hhmm < row.closes;
}
