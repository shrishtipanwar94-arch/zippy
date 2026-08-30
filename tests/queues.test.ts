// Queue infrastructure: the idempotency guarantee, the debounce that collapses
// a burst of triggers, dead-lettering on exhaustion, and the cleanup sweep's
// real effect. Real Redis and real Postgres throughout — an idempotency
// guarantee proved against a mock is not a guarantee about anything.

import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';

import { prismaBase } from '../src/infra/prismaBase.js';
import { createWorkerConnection, sharedQueueConnection } from '../src/queues/connection.js';
import { runIdempotently } from '../src/queues/idempotent.js';
import { enqueueDebounced } from '../src/queues/debounce.js';
import { moveToDeadLetterIfTerminal } from '../src/queues/deadLetter.js';
import { cappedExponentialBackoff } from '../src/queues/backoff.js';
import { processCleanup } from '../src/workers/cleanup.js';
import { deadLetterQueue } from '../src/queues/queues.js';

const TEST_PREFIX = 'qt-';

function testKey(): string {
  return `${TEST_PREFIX}${randomUUID()}`;
}

// Every temporary Queue/Worker this file spins up, so afterAll can close them
// all — an open BullMQ connection is an open TCP socket, and vitest will hang
// waiting for it if nothing closes it.
const openHandles: Array<{ close: () => Promise<void> }> = [];

function track<T extends { close: () => Promise<void> }>(handle: T): T {
  openHandles.push(handle);
  return handle;
}

// A throwaway Queue with a random name, used wherever a test needs its own
// queue rather than one of the four real ones — the debounce and dead-letter
// tests both need this, so it lives here once instead of twice.
function testQueue(prefix: string): Queue {
  return track(new Queue(`${prefix}-${randomUUID()}`, { connection: sharedQueueConnection }));
}

afterAll(async () => {
  await Promise.all(openHandles.map((handle) => handle.close().catch(() => undefined)));
  await prismaBase.jobProcessingLog.deleteMany({ where: { idempotencyKey: { startsWith: TEST_PREFIX } } });
  await prismaBase.$disconnect();
});

describe('runIdempotently', () => {
  it('runs the effect once and reports it was not already processed', async () => {
    const key = testKey();
    let calls = 0;

    const result = await runIdempotently('notification', key, async () => {
      calls += 1;
    });

    expect(result).toEqual({ alreadyProcessed: false });
    expect(calls).toBe(1);
  });

  it('does not re-run the effect for a key already logged', async () => {
    const key = testKey();
    let calls = 0;
    const effect = async () => {
      calls += 1;
    };

    await runIdempotently('notification', key, effect);
    const second = await runIdempotently('notification', key, effect);

    expect(second).toEqual({ alreadyProcessed: true });
    expect(calls).toBe(1);
  });

  // The same key on a DIFFERENT queue is a different claim — job_processing_log
  // is unique on (queue, idempotency_key) together, not the key alone, because
  // two unrelated queues could otherwise coincidentally mint the same id.
  it('scopes the key to the queue', async () => {
    const key = testKey();
    let calls = 0;
    const effect = async () => {
      calls += 1;
    };

    await runIdempotently('notification', key, effect);
    const onAnotherQueue = await runIdempotently('cleanup', key, effect);

    expect(onAnotherQueue).toEqual({ alreadyProcessed: false });
    expect(calls).toBe(2);
  });

  // If the effect fails, the transaction (log insert included) rolls back, so
  // the key is NOT marked done and a real retry can still do the work.
  it('does not log a key whose effect threw', async () => {
    const key = testKey();
    let calls = 0;

    await expect(
      runIdempotently('notification', key, async () => {
        calls += 1;
        throw new Error('effect failed');
      }),
    ).rejects.toThrow('effect failed');

    const retried = await runIdempotently('notification', key, async () => {
      calls += 1;
    });

    expect(retried).toEqual({ alreadyProcessed: false });
    expect(calls).toBe(2);
  });

  // THE PROPERTY THAT MATTERS: not "the app checks first", but "the database
  // enforces it" — proved by making two deliveries of the same key race for
  // real, the same way tests/assign.test.ts proves the unit claim races for
  // real rather than trusting the read-then-write order.
  it('lets only one of two concurrent deliveries of the same key run the effect', async () => {
    const key = testKey();
    let calls = 0;
    const effect = async () => {
      calls += 1;
    };

    const results = await Promise.all([
      runIdempotently('notification', key, effect),
      runIdempotently('notification', key, effect),
    ]);

    expect(calls).toBe(1);
    expect(results.filter((result) => !result.alreadyProcessed)).toHaveLength(1);
    expect(results.filter((result) => result.alreadyProcessed)).toHaveLength(1);
  });

  it('persists a queryable row for each key actually processed', async () => {
    const key = testKey();
    await runIdempotently('notification', key, async () => undefined);

    const row = await prismaBase.jobProcessingLog.findUniqueOrThrow({
      where: { queue_idempotencyKey: { queue: 'notification', idempotencyKey: key } },
    });
    expect(row.idempotencyKey).toBe(key);
  });
});

describe('enqueueDebounced', () => {
  // Drains a queue with a short-lived Worker and resolves once `expected` jobs
  // have completed (or the timeout elapses) — this is a real BullMQ pipeline,
  // not a stand-in for one.
  async function drain(queue: Queue, expected: number, timeoutMs: number): Promise<unknown[]> {
    const seen: unknown[] = [];
    const worker = track(
      new Worker(
        queue.name,
        async (job: Job) => {
          seen.push(job.data);
        },
        { connection: createWorkerConnection(`test:${queue.name}`) },
      ),
    );

    await new Promise<void>((resolve) => {
      const check = () => {
        if (seen.length >= expected) resolve();
      };
      worker.on('completed', check);
      setTimeout(resolve, timeoutMs);
    });

    return seen;
  }

  it('collapses many rapid calls with the same key into one job', async () => {
    const queue = testQueue('qt-debounce');
    const dedupeKey = testKey();

    for (let i = 0; i < 10; i += 1) {
      await enqueueDebounced(queue, 'test', dedupeKey, { i }, 300);
    }

    const seen = await drain(queue, 1, 2_000);
    expect(seen).toHaveLength(1);
    // The FIRST call's data wins — see the "plain mode" note in debounce.ts.
    expect(seen[0]).toEqual({ i: 0 });
  }, 10_000);

  it('does not collapse calls with different keys', async () => {
    const queue = testQueue('qt-debounce');

    await enqueueDebounced(queue, 'test', testKey(), { which: 'a' }, 200);
    await enqueueDebounced(queue, 'test', testKey(), { which: 'b' }, 200);

    const seen = await drain(queue, 2, 2_000);
    expect(seen).toHaveLength(2);
  }, 10_000);

  it('runs the one surviving job after the window, not immediately', async () => {
    const queue = testQueue('qt-debounce');
    const startedAt = Date.now();

    await enqueueDebounced(queue, 'test', testKey(), {}, 500);
    await drain(queue, 1, 2_000);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
  }, 10_000);
});

describe('cappedExponentialBackoff', () => {
  const MAX_DELAY_MS = 5 * 60 * 1000;

  it('doubles for the early attempts', () => {
    expect(cappedExponentialBackoff(1)).toBe(1_000);
    expect(cappedExponentialBackoff(2)).toBe(2_000);
    expect(cappedExponentialBackoff(3)).toBe(4_000);
    expect(cappedExponentialBackoff(9)).toBe(256_000); // still under the cap
  });

  it('stops doubling once the cap is reached, rather than growing forever', () => {
    // Uncapped, attempt 11 would be 1000 * 2^10 = 1,024,000ms — well past the
    // cap. Two attempts on OPPOSITE sides of where doubling would have
    // diverged, both landing on the same ceiling, is what proves it is
    // actually capped rather than merely large.
    expect(cappedExponentialBackoff(11)).toBe(MAX_DELAY_MS);
    expect(cappedExponentialBackoff(20)).toBe(MAX_DELAY_MS);
  });
});

describe('dead-lettering a terminally failed job', () => {
  it('moves the job only on its LAST attempt, not on a retry that will happen again', async () => {
    const queue = testQueue('qt-deadletter');
    const beforeCount = (await deadLetterQueue.getJobCounts('waiting', 'completed')).waiting ?? 0;

    await queue.add('always-fails', {}, { attempts: 2, backoff: { type: 'fixed', delay: 50 } });

    const worker = track(
      new Worker(
        queue.name,
        async () => {
          throw new Error('processor always fails, on purpose');
        },
        { connection: createWorkerConnection(`test:${queue.name}`) },
      ),
    );

    const failures: Job[] = [];
    worker.on('failed', (job) => {
      if (job) failures.push(job);
      void moveToDeadLetterIfTerminal('solver', job, new Error('processor always fails, on purpose'));
    });

    await new Promise<void>((resolve) => {
      const finished = setInterval(() => {
        if (failures.length >= 2) {
          clearInterval(finished);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(finished);
        resolve();
      }, 3_000);
    });

    expect(failures).toHaveLength(2);
    // Give the last, async moveToDeadLetterIfTerminal call a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const afterCount = (await deadLetterQueue.getJobCounts('waiting', 'completed')).waiting ?? 0;
    expect(afterCount - beforeCount).toBe(1);
  }, 10_000);
});

describe('processCleanup — the real sweep', () => {
  // `IdempotencyKey` is unique on (userId, scope, key) TOGETHER, not on `id` —
  // every row this block creates needs its own `key` value, not just its own
  // `id`, or the second insert collides with the first before the sweep ever
  // runs.
  async function fakeJob(id: string): Promise<Pick<Job, 'id' | 'log'>> {
    return { id, log: async () => 0 };
  }

  // `key`, not just `id`, is unique-ified per row: every row created below
  // needs its own `key` value, since the model's real uniqueness is on
  // (userId, scope, key) together.
  async function createIdempotencyKey(expiresAt: Date): Promise<string> {
    const id = `qt-idk-${randomUUID()}`;
    await prismaBase.idempotencyKey.create({
      data: { id, key: id, userId: 'qt-user', scope: 'test', expiresAt },
    });
    return id;
  }

  it('deletes an expired idempotency key and leaves a live one alone', async () => {
    const expiredId = await createIdempotencyKey(new Date(Date.now() - 60_000));
    const liveId = await createIdempotencyKey(new Date(Date.now() + 60_000));

    await processCleanup((await fakeJob(testKey())) as Job);

    expect(await prismaBase.idempotencyKey.findUnique({ where: { id: expiredId } })).toBeNull();
    expect(await prismaBase.idempotencyKey.findUnique({ where: { id: liveId } })).not.toBeNull();

    await prismaBase.idempotencyKey.deleteMany({ where: { id: liveId } });
  });

  it('is idempotent — running twice with the same job id sweeps only once', async () => {
    const jobId = testKey();
    const id = await createIdempotencyKey(new Date(Date.now() - 1_000));

    await processCleanup((await fakeJob(jobId)) as Job);
    // Second delivery of the SAME BullMQ job id — the log row already exists,
    // so runIdempotently skips the effect entirely on this call.
    await expect(processCleanup((await fakeJob(jobId)) as Job)).resolves.toBeUndefined();

    expect(await prismaBase.idempotencyKey.findUnique({ where: { id } })).toBeNull(); // deleted once, not an error twice
  });
});
