// EVERY JOB EVENT REACHES A BROWSER — the regression guard for a bug that
// survived four phases.
//
// `appendJobEvent` records into an outbox buffer that only exists inside
// `collectJobEvents(...)`. For a long time the only caller of that was
// `runIntakeTransaction`, so intake's events were fanned out and every other
// writer's — the saga committing a reservation, a technician marking
// themselves on scene, a confirmed promotion escalating a job to HIGH_RISK —
// were written to Postgres and silently never broadcast.
//
// IT LOOKED LIKE IT WORKED, which is why it lasted. `recordForPublish` finding
// no buffer is CORRECT for a seed or a script, and indistinguishable from a
// dropped event for a route. Every client hid it too: a reconnect replays from
// `job_events`, so a reload always showed the right thing, and each surface
// refetches after its own action. Only a second browser watching a job
// somebody else was changing would show nothing — and that is exactly what a
// promotion confirmed on a driver's phone is.
//
// So the shape of the bug is "a writer opened its own transaction and did not
// go through the wrapper", and that has a signature in the source: a file that
// calls `appendJobEvent` and also opens a bare `$transaction`. This asserts
// there are none. It is a source assertion, which is weaker than a DOM test
// and much stronger than nothing — and it turns a silent regression into a
// failing build, which is the property the original bug lacked entirely.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

// Comments stripped, for the fourth time in this project: several of the files
// below discuss `$transaction` in prose explaining why they do not call it
// bare, and a source assertion that cannot tell code from prose punishes the
// files that document themselves best.
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

// The two wrappers that collect the outbox and publish after the commit.
// Anything else opening a transaction around an event write drops it.
const SAFE_WRAPPERS = ['runPublishingTransaction(', 'runIntakeTransaction('];

describe('every writer of a job event publishes it', () => {
  const writers = sourceFiles('src')
    .filter((path) => !path.endsWith(join('intake', 'events.ts')))
    .filter((path) => code(path).includes('appendJobEvent('));

  it('finds the writers at all', () => {
    // A guard on an empty set passes for the wrong reason. There are a dozen
    // of these across the commit layer, the API and intake.
    expect(writers.length).toBeGreaterThan(8);
  });

  it('opens no transaction except through a publishing wrapper', () => {
    const offenders = writers.filter((path) => {
      const source = code(path);
      if (!/\.\$transaction\(/.test(source)) return false;
      return !SAFE_WRAPPERS.some((wrapper) => source.includes(wrapper));
    });

    expect(offenders).toEqual([]);
  });

  // The wrapper is only worth anything if it does both halves. Asserted on the
  // file itself rather than trusted, because "collect but never publish" is
  // precisely the failure that was live for four phases.
  it('collects the outbox and publishes after the commit', () => {
    const wrapper = code(join('src', 'realtime', 'transaction.ts'));
    expect(wrapper).toMatch(/collectJobEvents\(/);
    expect(wrapper).toMatch(/publishJobEvents\(events\)/);
    // Publishing must come AFTER the commit — the transaction can still roll
    // back and replay, and a browser cannot un-see an event.
    expect(wrapper.indexOf('collectJobEvents(')).toBeLessThan(
      wrapper.indexOf('publishJobEvents(events)'),
    );
  });
});
