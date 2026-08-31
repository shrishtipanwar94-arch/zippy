// Phase 13 check: THRASH CONTROL. Fires ten re-plan triggers for one zone as
// fast as the loop can issue them, and proves the debounce collapses them into
// one solve rather than ten.
//
//   npm run dev:worker            (in another terminal — it does the solving)
//   node scripts/fire-10-triggers-fast.js
//
// Then, in psql against the same database the worker uses:
//   SELECT COUNT(*) FROM solver_runs WHERE created_at > now() - interval '1 minute';
//   -- 1 or 2, not 10.
//
// WHY ONE OR TWO AND NOT EXACTLY ONE. The debounce window is 2 seconds
// (SOLVE_DEBOUNCE_MS). If the ten calls straddle a window boundary — the first
// one opens a window, the window closes, and a straggler opens a second — two
// solves is the correct answer, not a failure. Ten would mean the debounce is
// not working at all. Anything above two means it is collapsing far less than
// it should.
//
// WHAT A "TRIGGER" IS HERE. `enqueueSolve(zoneId)` is the single call every
// re-plan trigger makes (src/domain/replanTriggers.ts lists them; Phase 13
// Stage 3 records which ones have a production event source yet). This script
// makes that call ten times without going through the routes that would
// normally make it, because the thing under test is the queue's collapsing
// behaviour, not any particular trigger's plumbing.
//
// Plain JS with its own Queue, matching scripts/enqueue-100.js: no build step,
// no dependency on the app's module graph. The dedupe key and window are
// duplicated from src/workers/solver.ts rather than imported for that reason,
// and the constants are asserted against each other by
// tests/replanTriggers.test.ts so the copy cannot drift silently.

import { Queue } from 'bullmq';

const TRIGGER_COUNT = 10;
const ZONE_ID = process.env.ZONE_ID ?? 'zone-kor';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

// Mirrors SOLVE_DEBOUNCE_MS in src/workers/solver.ts.
const SOLVE_DEBOUNCE_MS = 2_000;

function urlToConnection(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
  };
}

const queue = new Queue('solver', {
  connection: { ...urlToConnection(REDIS_URL), maxRetriesPerRequest: null },
});

async function main() {
  console.log(`firing ${TRIGGER_COUNT} re-plan triggers for zone "${ZONE_ID}" as fast as possible...`);
  const startedAt = Date.now();

  for (let i = 1; i <= TRIGGER_COUNT; i += 1) {
    // Exactly what enqueueSolve does: one dedupe key per zone, so a burst of
    // triggers for the same zone claims the same window.
    await queue.add(
      'solve-zone',
      { zoneId: ZONE_ID, trigger: `FIRE_10_TRIGGER_${i}` },
      {
        delay: SOLVE_DEBOUNCE_MS,
        deduplication: { id: `zone:${ZONE_ID}`, ttl: SOLVE_DEBOUNCE_MS },
      },
    );
    console.log(`  trigger ${i}/${TRIGGER_COUNT} fired (+${Date.now() - startedAt}ms)`);
  }

  const elapsed = Date.now() - startedAt;
  console.log(`\nall ${TRIGGER_COUNT} fired in ${elapsed}ms (debounce window is ${SOLVE_DEBOUNCE_MS}ms)`);

  // How many actually reached the queue. BullMQ drops a duplicate add while a
  // dedupe key is claimed, so this is the collapse, visible before the worker
  // has even run.
  const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'completed');
  console.log('queue after the burst:', JSON.stringify(counts));

  console.log('\nnow check the database the worker is using:');
  console.log("  SELECT COUNT(*) FROM solver_runs WHERE created_at > now() - interval '1 minute';");
  console.log('  -- expect 1 or 2, not 10');

  await queue.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
