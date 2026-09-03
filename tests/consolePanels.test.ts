// THE PANELS' RENDERING DISCIPLINE, asserted against their source.
//
// Phase 14's acceptance check is visual: run the simulator at 40 jobs/hour,
// scroll halfway down, and wait — "either failure means a panel is blasting
// innerHTML". That check needs a browser and has not been performed.
//
// What CAN be checked without one is the specific defect it hunts for. The
// failure has a signature in the source: a live, scrolling panel that assigns
// to `innerHTML` on its container, or a map that recreates its layer, rebuilds
// every node on every event and throws away scroll position, open popups and
// pan state with it.
//
// These are source assertions, which are weaker than a DOM test and stronger
// than nothing. They cannot prove the console does not flicker; they can prove
// the two panels most at risk still follow the discipline that stops it, and
// they turn a silent regression into a failing build. The honest limit is
// recorded in DECISIONS.log rather than papered over here.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_KINDS } from '../src/domain/actionTiers.js';

// CODE ONLY, COMMENTS STRIPPED — and this is the third time this project has
// needed it. Phase 7's engine grep matched a comment explaining why Prisma was
// NOT imported; Phase 8's cost grep matched a comment listing what the file
// deliberately excludes; and `map.js` opens by promising it never calls
// `map.remove()`, which a naive search reads as a call.
//
// A source assertion that cannot tell code from prose punishes exactly the
// files that document themselves best. Stripping comments first fixes the
// mechanism rather than the wording, so a panel is free to name the thing it
// avoids.
function code(name: string): string {
  return readFileSync(join('public', 'js', 'panels', name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the live timeline patches rather than rebuilds', () => {
  const source = code('timeline.js');

  // The rows container is the thing that must never be wholesale replaced:
  // it is what the operator is scrolled into.
  it('never assigns innerHTML to the rows container', () => {
    expect(source).not.toMatch(/list\.innerHTML\s*=/);
    expect(source).not.toMatch(/timeline-rows[^\n]*innerHTML\s*=/);
  });

  it('adds and removes individual rows', () => {
    expect(source).toMatch(/list\.prepend\(/);
    expect(source).toMatch(/row\.remove\(\)/);
  });

  // Prepending to a scrolled list pushes content down by the height of what
  // was added. Without correcting for it, reading row 40 while three events
  // arrive silently moves the reader to row 43.
  it('corrects scroll position after prepending', () => {
    expect(source).toMatch(/scrollTop/);
    expect(source).toMatch(/scrollHeight/);
  });
});

describe('the map moves markers rather than recreating them', () => {
  const source = code('map.js');

  // The three ways to make every pin blink.
  it('never removes the map, clears the layer, or rebuilds the layer group', () => {
    expect(source).not.toMatch(/map\.remove\(\)/);
    expect(source).not.toMatch(/clearLayers\(/);
    // exactly one layerGroup, created once
    expect(source.match(/layerGroup\(/g)?.length ?? 0).toBe(1);
  });

  it('keeps a registry of markers so they can be found again', () => {
    expect(source).toMatch(/markers\s*=\s*new Map\(\)/);
    expect(source).toMatch(/markers\.get\(/);
    expect(source).toMatch(/markers\.delete\(/);
  });

  it('moves an existing marker in place', () => {
    expect(source).toMatch(/setLatLng\(/);
    expect(source).toMatch(/setStyle\(/);
  });

  it('creates the map only when it does not already exist', () => {
    expect(source).toMatch(/if \(!map\)/);
  });
});

describe('the panels that DO rebuild are the ones with nothing to lose', () => {
  // Stated as a test so the distinction is deliberate rather than accidental:
  // these show one selection's worth of content and change only when the
  // operator asks for something different, so there is no scroll position or
  // input state a rebuild would discard.
  //
  // THE QUEUE USED TO BE ON THIS LIST AND SHOULD NEVER HAVE BEEN. It is a live,
  // sorted, scrolling list that re-renders on every socket event — the same
  // shape as the timeline, not the same shape as the inspector — and asserting
  // its rebuild here made a defect look like a decision. Phase 22c moved it to
  // the patching group below. The assertion was the thing that was wrong, not
  // the panel.
  it('inspector and scarcity use replaceChildren', () => {
    for (const name of ['inspector.js', 'scarcity.js']) {
      expect(code(name), name).toMatch(/replaceChildren\(/);
    }
  });
});

// ---------------------------------------------------------------------------
// THE PRIORITY QUEUE — the column a dispatcher lives in, and the one panel of
// the three live lists that never followed the discipline.
//
// Phase 14's check is "scroll halfway down, wait, and see whether you are still
// there". The queue failed it for a reason that had nothing to do with
// performance: `replaceChildren` on every tick destroyed and recreated every
// row, so a selection, a focused button and any text the operator had
// highlighted all went with it — several times a minute on a busy board.

describe('the priority queue patches rows rather than rebuilding the table', () => {
  const source = code('queue.js');

  it('never rebuilds its container', () => {
    expect(source).not.toMatch(/replaceChildren\(/);
    // `innerHTML` on a freshly created row element is fine and is how the cells
    // are stamped out once; assigning it to the PANEL or the tbody is the
    // defect, because that is what discards every existing node.
    expect(source).not.toMatch(/panel\.innerHTML\s*=/);
    expect(source).not.toMatch(/body\.innerHTML\s*=/);
  });

  it('keys rows by job so an existing one can be found and updated in place', () => {
    expect(source).toMatch(/dataset\.jobId/);
    expect(source).toMatch(/row\.remove\(\)/);
  });

  // Colour is never the only signal (docs/UI.md). Every risk and SLA state on a
  // queue row carries its word, so the row survives a colourblind operator and
  // a laptop screen in daylight.
  it('labels risk and SLA in words, not only in colour', () => {
    for (const word of ['HIGH RISK', 'ELEVATED', 'STANDARD', 'NO SLA', 'SLA LATE']) {
      expect(source, word).toContain(word);
    }
  });
});


// ---------------------------------------------------------------------------
// THE ACTION QUEUE'S LABEL MAP, against the kinds that actually exist.
//
// A CORRESPONDENCE BETWEEN A SERVER ENUM AND A BROWSER LABEL MAP is the exact
// shape of bug the Phase 22b audit kept finding, and this is the third one:
// `actions.js` opened with four labels, two of which — SLA_BREACH_FOLLOW_UP
// and CONTENTION_REVIEW — named nothing the system has ever raised. So five of
// the seven kinds a dispatcher can be shown fell through to the raw enum and
// put ESCALATE_SLA_WINDOW_CLOSED on screen as a card title.
//
// Neither half is wrong on its own, which is why nothing caught it: the server
// raises valid kinds and the browser renders whatever it is given. Only the
// JOIN is wrong, so only a test that reads both can see it.

describe('every action kind the system can raise has a label on the console', () => {
  const source = code('actions.js');

  // The map is a JS object literal in a panel this test cannot import, so both
  // assertions read its source. `kindLabelKeys` isolates the KIND_LABEL block
  // first — the file also holds TIER_LABEL, whose keys are legitimately not
  // action kinds, and a scan over the whole file would flag them.
  const labelled = kindLabelKeys(source);

  it.each([...ACTION_KINDS])('has a plain-language label for %s', (kind) => {
    expect(labelled.get(kind), kind).toBeTruthy();
    // A key with an empty value would still be present, so the label's own text
    // has to be checked as well.
    expect((labelled.get(kind) ?? '').length, kind).toBeGreaterThan(4);
  });

  it('does not carry labels for kinds that do not exist', () => {
    // The two invented keys are the reason this file exists. A label map with
    // entries nothing can raise is a map nobody has checked against reality.
    const known = new Set<string>(ACTION_KINDS);
    expect([...labelled.keys()].filter((key) => !known.has(key))).toEqual([]);
  });
});

// KIND_LABEL's own keys and values, read out of the panel's source.
function kindLabelKeys(source: string): Map<string, string> {
  const block = source.slice(source.indexOf('const KIND_LABEL'));
  const body = block.slice(0, block.indexOf('};'));
  const entries = new Map<string, string>();
  for (const match of body.matchAll(/([A-Z][A-Z0-9_]+):\s*'([^']*)'/g)) {
    entries.set(match[1]!, match[2]!);
  }
  return entries;
}
