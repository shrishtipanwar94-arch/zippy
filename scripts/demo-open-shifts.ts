// PUT THE WHOLE WORKFORCE ON SHIFT FOR THE NEXT TWELVE HOURS.
//
// The seed gives each technician a realistic shift band — morning, day,
// evening, or one of the four night crews — so at 3am exactly four of the
// thirty-one are on duty and almost every job comes back
// NO_TECHNICIAN_ON_SHIFT. That is correct behaviour and it is the right
// default for the evaluation harness, which fixes its own clock.
//
// It is the wrong default for somebody sitting down to walk a job through the
// four surfaces at whatever hour they happen to be free. This widens every
// technician's CURRENT shift to cover the next twelve hours so the board is
// dispatchable now.
//
// DEMO PREP ONLY, and it is not subtle about what it changes: it edits the
// same `technician_shifts` rows the solver reads, through the same field the
// duty toggle writes (src/commit/technicianDuty.ts). Run it after
// `db:reset && db:seed`, and re-run it if you come back the next day.
//
//   npx tsx scripts/demo-open-shifts.ts

import { prismaBase } from '../src/infra/prismaBase.js';

const HOURS = 12;

async function main(): Promise<void> {
  const now = new Date();
  const until = new Date(now.getTime() + HOURS * 60 * 60_000);

  // Widen the shift that is closest to now rather than inventing a new row:
  // two overlapping shifts for one technician is a state the seed already
  // takes care to avoid, and the roster is meant to read as what was worked.
  const technicians = await prismaBase.technician.findMany({ select: { id: true } });

  let widened = 0;
  for (const technician of technicians) {
    const shift = await prismaBase.technicianShift.findFirst({
      where: { technicianId: technician.id },
      orderBy: { startsAt: 'desc' },
      select: { id: true, startsAt: true },
    });
    if (!shift) continue;

    await prismaBase.technicianShift.update({
      where: { id: shift.id },
      data: {
        startsAt: shift.startsAt < now ? shift.startsAt : now,
        endsAt: until,
      },
    });
    widened += 1;
  }

  // COUNT PEOPLE, NOT ROWS. The seed writes two shifts per technician —
  // yesterday's and today's — so a row count here reports 35 for a workforce of
  // 31, which reads as a bug in the thing you just ran.
  const covering = await prismaBase.technicianShift.findMany({
    where: { startsAt: { lte: now }, endsAt: { gte: now } },
    select: { technicianId: true },
  });
  const onShift = new Set(covering.map((shift) => shift.technicianId)).size;

  // eslint-disable-next-line no-console
  console.log(`widened ${widened} shifts; ${onShift} technicians are on shift until ${until.toISOString()}`);
  await prismaBase.$disconnect();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
