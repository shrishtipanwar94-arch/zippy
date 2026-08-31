// THE OFFLINE QUEUE'S CLIENT SIDE, actually run.
//
// tests/technicianActions.test.ts proves the SERVER survives a replay. This
// file proves the phone builds the replay correctly in the first place, which
// is the other half and the half a server test cannot reach: a queue that
// mints a fresh idempotency key on every retry would sail through the server
// suite and double-transition every job in production.
//
// It can be run for real rather than grepped because /js/offlineQueue.js
// touches no DOM. Its whole dependency surface is `window.localStorage`,
// `navigator.onLine` and `crypto.randomUUID`, all of which are a few lines to
// stand up in node — so these are behavioural assertions, not source
// assertions, and they exercise the same file the browser loads.
//
// The import is dynamic and built from a variable path on purpose: TypeScript
// cannot type a plain .js file from /public, so the module's shape is declared
// here as the contract this test depends on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type QueuedItem = {
  idempotencyKey: string;
  clientSequence: number;
  eventTime: string;
  jobId: string;
  step: string;
  completionCode?: string;
};

type QueueModule = {
  configureQueue(options: {
    send: (item: QueuedItem) => Promise<{ outcome: string; detail?: string }>;
    onChange?: () => void;
  }): void;
  enqueue(action: { jobId: string; step: string; completionCode?: string }): void;
  drain(): Promise<void>;
  pending(): QueuedItem[];
  recentResults(): { step: string; outcome: string; detail?: string }[];
};

const MODULE_PATH = pathToFileURL(join(process.cwd(), 'public', 'js', 'offlineQueue.js')).href;

// A localStorage that behaves like the real one: string keys, string values,
// survives everything except being replaced.
function makeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  };
}

let storage: ReturnType<typeof makeStorage>;
let sent: QueuedItem[];

function setOnline(online: boolean): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: online },
    configurable: true,
    writable: true,
  });
}

async function loadQueue(): Promise<QueueModule> {
  // The module holds state in module scope, so each test gets a fresh copy —
  // otherwise one test's half-drained queue is the next test's starting point.
  vi.resetModules();
  return (await import(/* @vite-ignore */ MODULE_PATH)) as QueueModule;
}

// The queue drains on a promise chain that `enqueue` starts and does not
// await. Letting the event loop turn is how a test waits for it, and it is
// what the browser does too.
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  storage = makeStorage();
  sent = [];
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage, addEventListener: () => {} },
    configurable: true,
    writable: true,
  });
  setOnline(true);
});

afterEach(() => {
  vi.resetModules();
});

describe('an action taken with no signal', () => {
  it('is kept, with a key minted at the tap', async () => {
    const queue = await loadQueue();
    queue.configureQueue({ send: async (item) => { sent.push(item); return { outcome: 'APPLIED' }; } });
    setOnline(false);

    queue.enqueue({ jobId: 'job-1', step: 'EN_ROUTE' });
    await settle();

    expect(sent).toHaveLength(0);
    const held = queue.pending();
    expect(held).toHaveLength(1);
    expect(held[0]?.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    // The tap time, not the send time. The gap between the two is the outage.
    expect(Date.parse(held[0]?.eventTime ?? '')).not.toBeNaN();
  });

  it('survives being reloaded — the queue is on disk, not in memory', async () => {
    const first = await loadQueue();
    first.configureQueue({ send: async () => ({ outcome: 'APPLIED' }) });
    setOnline(false);
    first.enqueue({ jobId: 'job-1', step: 'EN_ROUTE' });
    await settle();

    // A new module instance is a reloaded page. Same localStorage.
    const reloaded = await loadQueue();
    expect(reloaded.pending()).toHaveLength(1);
  });
});

describe('draining on reconnect', () => {
  it('sends four actions in the order they were tapped, one at a time', async () => {
    const queue = await loadQueue();
    let inFlight = 0;
    queue.configureQueue({
      send: async (item) => {
        // STRICTLY SEQUENTIAL. Two in flight at once would let "arrived" land
        // before "on my way" and put the driver's trail out of order.
        inFlight += 1;
        expect(inFlight).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        sent.push(item);
        return { outcome: 'APPLIED' };
      },
    });

    setOnline(false);
    for (const step of ['EN_ROUTE', 'ARRIVED', 'DIAGNOSING', 'WORKING']) {
      queue.enqueue({ jobId: 'job-1', step });
    }
    await settle();
    expect(sent).toHaveLength(0);

    setOnline(true);
    await queue.drain();

    expect(sent.map((item) => item.step)).toEqual([
      'EN_ROUTE',
      'ARRIVED',
      'DIAGNOSING',
      'WORKING',
    ]);
    // The phone's own counter, climbing. It is what makes "applied in original
    // order" checkable on the server afterwards.
    expect(sent.map((item) => item.clientSequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(sent.map((item) => item.idempotencyKey)).size).toBe(4);
    expect(queue.pending()).toHaveLength(0);
  });

  // THE ONE THAT MATTERS ON THIS SIDE. A key generated at send time would be a
  // new key on every retry, and the server's unique index would never fire.
  it('retries with the SAME key it minted at the tap', async () => {
    const queue = await loadQueue();
    let attempt = 0;
    queue.configureQueue({
      send: async (item) => {
        attempt += 1;
        sent.push(item);
        // First attempt: the connection drops mid-request. A thrown fetch has
        // no status, which is how the queue tells a network failure from an
        // answer.
        if (attempt === 1) throw new Error('network');
        return { outcome: 'APPLIED' };
      },
    });

    queue.enqueue({ jobId: 'job-1', step: 'ARRIVED' });
    await settle();

    // Still held, because nothing answered.
    expect(queue.pending()).toHaveLength(1);
    await queue.drain();

    expect(sent).toHaveLength(2);
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    expect(queue.pending()).toHaveLength(0);
  });

  it('stops at the head on a network failure rather than skipping past it', async () => {
    const queue = await loadQueue();
    queue.configureQueue({
      send: async (item) => {
        sent.push(item);
        throw new Error('network');
      },
    });

    setOnline(false);
    queue.enqueue({ jobId: 'job-1', step: 'EN_ROUTE' });
    queue.enqueue({ jobId: 'job-1', step: 'ARRIVED' });
    await settle();

    setOnline(true);
    await queue.drain();

    // Only the head was attempted; the second must not overtake it.
    expect(sent.map((item) => item.step)).toEqual(['EN_ROUTE']);
    expect(queue.pending().map((item) => item.step)).toEqual(['EN_ROUTE', 'ARRIVED']);
  });

  // A rejection is an ANSWER, not a failure. Retrying it forever is a queue
  // that never drains — which is why the server answers 200 for every outcome.
  it('drops an action the server refused, and keeps the reason', async () => {
    const queue = await loadQueue();
    queue.configureQueue({
      send: async (item) => {
        sent.push(item);
        return { outcome: 'REJECTED', detail: 'that code does not match' };
      },
    });

    queue.enqueue({ jobId: 'job-1', step: 'COMPLETE', completionCode: '000000' });
    await settle();

    expect(queue.pending()).toHaveLength(0);
    expect(queue.recentResults()[0]).toMatchObject({
      step: 'COMPLETE',
      outcome: 'REJECTED',
      detail: 'that code does not match',
    });
  });

  it('tells the page every time the queue changes', async () => {
    const queue = await loadQueue();
    let changes = 0;
    queue.configureQueue({
      send: async () => ({ outcome: 'APPLIED' }),
      onChange: () => {
        changes += 1;
      },
    });

    queue.enqueue({ jobId: 'job-1', step: 'EN_ROUTE' });
    await settle();

    // Once when it was queued, once when it left. Both matter on screen: a tap
    // that is waiting and a tap that landed look identical otherwise.
    expect(changes).toBeGreaterThanOrEqual(2);
  });
});
