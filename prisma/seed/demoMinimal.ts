/**
 * `npm run db:seed:demo` — put the demo board on whatever database DATABASE_URL
 * points at, by running ensureDemoBoard (prisma/seed/demoBoard.ts).
 *
 * This is also what the web process runs on boot when DEMO_MODE=true (see
 * scripts/start-process.sh), so a deployed demo never needs seeding by hand.
 * It is idempotent: running it twice leaves the same rows as running it once.
 *
 * A VAN ON A LIVE JOB IS LEFT ALONE rather than refused. The first version of
 * this seeder refused to run at all while the demo van had a live job, because
 * forcing that van back to AVAILABLE would let a second job onto it (invariant
 * 7). Running on every boot, a refusal would stop the web process from
 * starting, so the busy van is now skipped instead and named in the output.
 */

import { prisma } from './client.js';
import { ensureDemoBoard } from './demoBoard.js';
import { DEMO_CREWS } from '../../src/demo/demoCrews.js';

async function main(): Promise<void> {
  const summary = await ensureDemoBoard(prisma);

  const crewLines = DEMO_CREWS.map(
    (crew) => `  ${crew.label}  ${crew.unitCode}  ${crew.name.padEnd(15)} ${crew.capabilities.join(', ')}`,
  );
  const busyLine =
    summary.busyUnitCodes.length > 0
      ? `  left alone, on a live job: ${summary.busyUnitCodes.join(', ')}\n`
      : '';

  // eslint-disable-next-line no-console
  console.log(
    `demo board ready: 1 zone, 1 dispatcher, 1 driver, ${summary.crewsReady} of ${DEMO_CREWS.length} crews refreshed\n` +
      `${crewLines.join('\n')}\n` +
      busyLine +
      `  reference job: ${summary.referenceJob.created ? 'created' : 'already there'}, ` +
      `${summary.referenceJob.status ?? 'none'}
` +
      '  check it: npx tsx scripts/demo-dry-check.ts',
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
