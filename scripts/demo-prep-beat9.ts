// DEMO PREP — Beat 9 of DEMO_SCRIPT.md (fleet dashboard, repeat-pattern flag).
//
// A fresh `db:seed` leaves the fleet dashboard with no history: slaMetPercent
// and every repeatPatternFlag come back null. This inserts three RESOLVED
// FLAT_BATTERY incidents on vehicle-metrocab-1 so:
//   - repeatPatternFlag trips  (REPEAT_PATTERN_MIN_COUNT = 3, 60-day window)
//   - slaMetPercent / meanResolutionMinutes / spend are non-null
//     (all three dated THIS month; those figures are month-scoped)
//
// Run once, AFTER `npm run db:reset && npm run db:seed`:
//   npx tsx scripts/demo-prep-beat9.ts
//
// It is insert-only: Postgres blocks DELETE on job_events, so the only clean
// way to remove these rows is another db:reset. Re-running is idempotent on the
// job rows (upsert) but appends a second TECHNICIAN_ARRIVED per job, so prefer
// a reset over a re-run.

import { prismaBase } from '../src/infra/prismaBase.js';

const NOW = new Date();
const VEHICLE = 'vehicle-metrocab-1';
const DRIVER = 'driver-metrocab-1';
const TENANT = 'tenant-metrocab';
const ZONE = 'zone-kor';
const SLA = 'sla-tenant-metrocab-standard'; // responseMinutes = 30

// Three battery incidents this month. arriveMin < 30 meets the response
// window; one is deliberately late so the mix is not a trivial 100%.
const INCIDENTS = [
  { i: 0, hoursAgo: 6, arriveMin: 19 },
  { i: 1, hoursAgo: 27, arriveMin: 44 },
  { i: 2, hoursAgo: 34, arriveMin: 12 },
];

async function main(): Promise<void> {
  for (const { i, hoursAgo, arriveMin } of INCIDENTS) {
    const id = `demo-prep-batt-${i}`;
    const createdAt = new Date(NOW.getTime() - hoursAgo * 60 * 60_000);
    const arrivedAt = new Date(createdAt.getTime() + arriveMin * 60_000);
    const resolvedAt = new Date(createdAt.getTime() + (arriveMin + 32) * 60_000);

    await prismaBase.job.upsert({
      where: { id },
      update: { status: 'RESOLVED', createdAt, resolvedAt, slaPolicyId: SLA, serviceType: 'STANDARD' },
      create: {
        id,
        tenantId: TENANT,
        driverId: DRIVER,
        vehicleId: VEHICLE,
        zoneId: ZONE,
        status: 'RESOLVED',
        safetyLevel: 'NORMAL',
        serviceType: 'STANDARD',
        slaPolicyId: SLA,
        createdAt,
        resolvedAt,
        lat: 12.9352,
        lng: 77.6245,
      },
    });

    await prismaBase.faultHypothesis.deleteMany({ where: { jobId: id } });
    await prismaBase.faultHypothesis.create({
      data: {
        jobId: id,
        distribution: { FLAT_BATTERY: 1 },
        requiredCapabilityCodes: ['BATTERY_REPLACEMENT', 'JUMP_START'],
        entropy: 0,
        topFault: 'FLAT_BATTERY',
        version: 0,
        createdAt,
      },
    });

    const hasArrival = await prismaBase.jobEvent.findFirst({
      where: { jobId: id, eventType: 'TECHNICIAN_ARRIVED' },
      select: { id: true },
    });
    if (!hasArrival) {
      await prismaBase.jobEvent.create({
        data: { jobId: id, sequence: 1, eventType: 'TECHNICIAN_ARRIVED', at: arrivedAt },
      });
    }

    await prismaBase.estimate.deleteMany({ where: { jobId: id } });
    await prismaBase.estimate.create({
      data: { jobId: id, status: 'APPROVED', subtotalPaise: 180_000, totalPaise: 180_000, coveredPaise: 180_000 },
    });

    // eslint-disable-next-line no-console
    console.log('seeded', id, createdAt.toISOString(), `arrive+${arriveMin}m`);
  }

  await prismaBase.$disconnect();
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});
