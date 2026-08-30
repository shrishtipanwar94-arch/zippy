// Phase 5 check: enqueues 100 jobs, each with its own idempotency key, onto
// the `notification` queue — the same queue `npm run dev:worker` processes.
//
//   node scripts/enqueue-100.js
//   (while it runs, or right after) npm run dev:worker
//   kill the worker around job ~50, run `npm run dev:worker` again
//
// Then, in psql:
//   SELECT COUNT(*), COUNT(DISTINCT idempotency_key) FROM job_processing_log;
//   -- both must read 100 — every job ran exactly once, restart or not.
//
// Plain JS, not TypeScript, and it builds its own `Queue` rather than
// importing src/queues/queues.js: this script's only job is to put 100 real,
// independent jobs in front of the real worker, and it should not need a
// build step or the app's own module graph to do that. `jobId` is left for
// BullMQ to generate — a distinct job per call is exactly what the check
// needs, and the debounce path in src/queues/debounce.ts is deliberately not
// used here, because debouncing 100 rapid calls would collapse most of them
// away, which is the opposite of what this check is proving.

import { Queue } from 'bullmq';

const JOB_COUNT = 100;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const queue = new Queue('notification', {
  connection: { ...urlToConnection(REDIS_URL), maxRetriesPerRequest: null },
});

function urlToConnection(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
  };
}

async function main() {
  console.log(`enqueueing ${JOB_COUNT} jobs onto "notification"...`);

  for (let i = 1; i <= JOB_COUNT; i += 1) {
    await queue.add('notify-test', { index: i }, { attempts: 5 });
    if (i % 10 === 0) console.log(`  enqueued ${i}/${JOB_COUNT}`);
  }

  console.log('done. Start (or restart) the worker to process them:');
  console.log('  npm run dev:worker');
  await queue.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
