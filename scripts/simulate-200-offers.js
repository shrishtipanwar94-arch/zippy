// Phase 22 check: LEARNED P(accept) actually moves.
//
//   node scripts/simulate-200-offers.js --workshop A --decline-evenings
//
// Writes 200 fabricated DestinationOffer + AcceptanceOutcome pairs against
// one seeded workshop, ground truth 80% accept everywhere EXCEPT the evening
// bucket (18:00-23:59 IST), which drops to 20% when --decline-evenings is
// passed. Then, in psql against the same database:
//
//   SELECT hour_bucket, vehicle_class, accepted_count, refused_count, p_accept
//   FROM workshop_acceptance
//   WHERE workshop_code = 'WS-KOR-A'
//   ORDER BY hour_bucket;
//   -- evening p_accept measurably lower than morning/afternoon/night
//
// The RANKING half of the check is `npm run eval` or a fresh /solve against a
// job needing this workshop at an evening hour: with --decline-evenings run,
// a further-but-more-reliable workshop should now win the destination
// screening a nearer, evening-shy one used to.
//
// PLAIN JS WITH ITS OWN PrismaClient, not imported TypeScript — the same
// choice scripts/enqueue-100.js makes for BullMQ: this script's only job is
// to put real rows in front of the real read path
// (src/commit/dispatchSnapshot.ts), and it should not need a build step or
// the app's own module graph to do that. HOUR_BUCKETS and PRIOR_ALPHA/BETA
// are NOT duplicated here — this script writes raw outcomes and lets the
// application's own src/domain/workshopAcceptance.ts (and the migration's
// SQL view) turn them into a probability, so there is nothing here that
// could drift from that formula.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const OFFER_COUNT = 200;
const RUN = `sim200-${Date.now()}`;

const args = process.argv.slice(2);
const declineEvenings = args.includes('--decline-evenings');
const workshopArg = valueAfter('--workshop') ?? 'A';

function valueAfter(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

// A bare letter ("A", "B") is shorthand for that suffix on the FIRST seeded
// zone (KOR) — prisma/seed/workshops.ts's own code scheme, `WS-<ZONE>-<A|B>`.
// A full code is used as given.
function resolveWorkshopCode(arg) {
  return /^[A-Za-z]$/.test(arg) ? `WS-KOR-${arg.toUpperCase()}` : arg;
}

// IST, same offset src/domain/workshopAcceptance.ts uses — duplicated as a
// number here for the same "each file owns its own small vocabulary" reason
// every domain file in this project follows for this exact constant.
const IST_OFFSET_MINUTES = 5 * 60 + 30;

function hourBucketFor(at) {
  const ist = new Date(at.getTime() + IST_OFFSET_MINUTES * 60_000);
  const hour = ist.getUTCHours();
  if (hour < 6) return 'NIGHT';
  if (hour < 12) return 'MORNING';
  if (hour < 18) return 'AFTERNOON';
  return 'EVENING';
}

// Spreads 200 fabricated moments across a week, weighted toward no particular
// hour — a real offer history is not evenly distributed either, and the
// point here is bucket coverage, not a claim about traffic patterns.
function randomMoment() {
  const daysAgo = Math.random() * 7;
  const hour = Math.floor(Math.random() * 24);
  const minute = Math.floor(Math.random() * 60);
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  at.setUTCHours(hour, minute, 0, 0);
  return at;
}

function groundTruthAcceptRate(bucket) {
  if (declineEvenings && bucket === 'EVENING') return 0.2;
  return 0.8;
}

function drawOutcome(acceptRate) {
  if (Math.random() < acceptRate) return 'ACCEPTED';
  // Most refusals are a clean decline; a smaller share are a workshop that
  // never answered at all.
  return Math.random() < 0.7 ? 'DECLINED' : 'TIMEOUT';
}

async function ensureFixture(workshopCode) {
  const workshop = await prisma.workshop.findUnique({
    where: { code: workshopCode },
    select: { id: true },
  });
  if (!workshop) {
    throw new Error(
      `no workshop with code "${workshopCode}" — run "npm run db:seed" first, or pass --workshop <a real code>`,
    );
  }

  const zone = await prisma.zone.findFirst({ select: { id: true, centroidLat: true, centroidLng: true } });
  if (!zone) throw new Error('no zone seeded — run "npm run db:seed" first');

  // KEYED ON THE NATURAL UNIQUE, NOT ON `RUN`. Every other row this fixture
  // creates carries the run id in its own identity, so a second run makes a
  // second row and nothing collides. This one cannot: `vehicle_profiles` has a
  // unique on (make, model, year_from, year_to) and those four values are
  // fixed, so an upsert keyed on `${RUN}-profile` never matches the row the
  // last run left behind and the create then violates the constraint. The
  // script therefore only ever worked on a freshly reset database, which is
  // where the demo prep happens to call it — running the prep a second time
  // without a reset failed here.
  const profile = await prisma.vehicleProfile.upsert({
    where: {
      make_model_yearFrom_yearTo: {
        make: 'SIMULATE_200',
        model: 'Fixture',
        yearFrom: 2020,
        yearTo: 2025,
      },
    },
    update: {},
    create: {
      id: `${RUN}-profile`,
      make: 'SIMULATE_200',
      model: 'Fixture',
      yearFrom: 2020,
      yearTo: 2025,
      bodyType: 'HATCHBACK',
      fuelType: 'PETROL',
      keyType: 'SMART',
    },
    select: { id: true },
  });

  const driverUser = await prisma.user.upsert({
    where: { id: `${RUN}-driver-user` },
    update: {},
    create: {
      id: `${RUN}-driver-user`,
      email: `${RUN}-driver@example.test`,
      passwordHash: 'not-used',
      role: 'DRIVER',
      name: 'Simulated Driver',
    },
    select: { id: true },
  });
  const driver = await prisma.driver.upsert({
    where: { id: `${RUN}-driver` },
    update: {},
    create: { id: `${RUN}-driver`, userId: driverUser.id },
    select: { id: true },
  });
  const vehicle = await prisma.vehicle.upsert({
    where: { id: `${RUN}-vehicle` },
    update: {},
    create: {
      id: `${RUN}-vehicle`,
      driverId: driver.id,
      profileId: profile.id,
      registration: `${RUN.slice(0, 15).toUpperCase()}`,
      colour: 'White',
    },
    select: { id: true },
  });
  const job = await prisma.job.upsert({
    where: { id: `${RUN}-job` },
    update: {},
    create: {
      id: `${RUN}-job`,
      driverId: driver.id,
      vehicleId: vehicle.id,
      zoneId: zone.id,
      status: 'RESOLVED', // terminal, so nothing live ever tries to dispatch it
      lat: zone.centroidLat,
      lng: zone.centroidLng,
    },
    select: { id: true },
  });

  return { workshopId: workshop.id, jobId: job.id };
}

async function main() {
  const workshopCode = resolveWorkshopCode(workshopArg);
  console.log(`simulating ${OFFER_COUNT} destination offers against workshop "${workshopCode}"...`);
  if (declineEvenings) console.log('  --decline-evenings: ground truth accept rate drops to 20% in the evening bucket');

  const { workshopId, jobId } = await ensureFixture(workshopCode);

  const tally = {};
  for (let i = 0; i < OFFER_COUNT; i += 1) {
    const at = randomMoment();
    const bucket = hourBucketFor(at);
    const outcome = drawOutcome(groundTruthAcceptRate(bucket));

    const offer = await prisma.destinationOffer.create({
      data: {
        jobId,
        workshopId,
        status: outcome,
        sentAt: at,
        expiresAt: new Date(at.getTime() + 5 * 60_000),
        respondedAt: at,
      },
      select: { id: true },
    });
    await prisma.acceptanceOutcome.create({
      data: {
        destinationOfferId: offer.id,
        workshopId,
        outcome,
        hourBucket: bucket,
        vehicleClass: 'NONE',
        recordedAt: at,
      },
    });

    tally[bucket] = tally[bucket] ?? { ACCEPTED: 0, DECLINED: 0, TIMEOUT: 0 };
    tally[bucket][outcome] += 1;
  }

  console.log('\nwritten, by hour bucket:');
  for (const [bucket, counts] of Object.entries(tally)) {
    console.log(`  ${bucket}: ${JSON.stringify(counts)}`);
  }

  console.log('\nnow check the learned probability:');
  console.log('  SELECT hour_bucket, vehicle_class, accepted_count, refused_count, p_accept');
  console.log('  FROM workshop_acceptance');
  console.log(`  WHERE workshop_code = '${workshopCode}'`);
  console.log('  ORDER BY hour_bucket;');
  console.log('  -- evening p_accept measurably lower than the other buckets, if --decline-evenings was passed');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
