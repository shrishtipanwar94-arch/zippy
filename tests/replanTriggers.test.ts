// The re-solve trigger list and the action-tier table — both pure, both
// policy, both the kind of thing that rots silently.
//
// A trigger list nobody enumerates grows a tenth member in a route somewhere;
// a tier table nobody checks acquires an AUTO entry that reassigns a van. The
// tests below are cheap and exist to make either of those a failing build
// rather than a discovery.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  REPLAN_TRIGGERS,
  MATERIAL_MOVE_METRES,
  MAX_REASSIGNMENTS_BEFORE_ESCALATION,
  causesResolve,
  isMaterialMove,
  isReplanTrigger,
  shouldEscalateForThrash,
  terminatesJob,
} from '../src/domain/replanTriggers.js';
import { ACTION_KINDS, tierFor, executesImmediately } from '../src/domain/actionTiers.js';

describe('the trigger list', () => {
  // The eight the build plan names, pinned by name. A ninth may be added
  // deliberately; it may not appear by accident.
  it('contains every trigger the build plan specifies', () => {
    for (const trigger of [
      'DIAGNOSIS_CHANGED',
      'TECHNICIAN_DECLINED',
      'TECHNICIAN_OFFLINE',
      'UNIT_BREAKDOWN',
      'DESTINATION_DECLINED',
      'DRIVER_MOVED_MATERIALLY',
      'SAFETY_LEVEL_CHANGED',
      'JOB_CANCELLED',
    ]) {
      expect(REPLAN_TRIGGERS, trigger).toContain(trigger);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(REPLAN_TRIGGERS).size).toBe(REPLAN_TRIGGERS.length);
  });

  it('rejects a string that is not a trigger', () => {
    expect(isReplanTrigger('DIAGNOSIS_CHANGED')).toBe(true);
    expect(isReplanTrigger('GPS_PING')).toBe(false);
  });

  // THE ONE PLACE RULE, asserted against the source rather than trusted. A
  // second literal list somewhere else is exactly how the first one stops
  // being the answer.
  it('is the only place the triggers are enumerated', () => {
    const redispatch = readFileSync('src/commit/redispatch.ts', 'utf8');
    expect(redispatch).toMatch(/from '\.\.\/domain\/replanTriggers\.js'/);
    // No inline re-listing of trigger names in the orchestrator.
    expect(redispatch).not.toMatch(/'TECHNICIAN_OFFLINE'|'UNIT_BREAKDOWN'/);
  });

  it('treats a cancellation as ending the job rather than re-planning it', () => {
    expect(terminatesJob('JOB_CANCELLED')).toBe(true);
    expect(causesResolve('JOB_CANCELLED')).toBe(false);
    expect(causesResolve('DIAGNOSIS_CHANGED')).toBe(true);
  });
});

describe('do not re-solve on every GPS ping', () => {
  const roadside = { lat: 28.6152, lng: 77.2095 };

  it('ignores a move within GPS noise', () => {
    // ~11 metres north.
    expect(isMaterialMove(roadside, { lat: 28.6153, lng: 77.2095 })).toBe(false);
  });

  it('reacts to a move that could change the nearest unit', () => {
    // ~1.1km north.
    expect(isMaterialMove(roadside, { lat: 28.6252, lng: 77.2095 })).toBe(true);
  });

  it('has a threshold well above a consumer GPS fix', () => {
    expect(MATERIAL_MOVE_METRES).toBeGreaterThanOrEqual(100);
  });
});

describe('thrash control', () => {
  it('escalates only once the cap is reached', () => {
    expect(shouldEscalateForThrash(MAX_REASSIGNMENTS_BEFORE_ESCALATION - 1)).toBe(false);
    expect(shouldEscalateForThrash(MAX_REASSIGNMENTS_BEFORE_ESCALATION)).toBe(true);
    expect(shouldEscalateForThrash(MAX_REASSIGNMENTS_BEFORE_ESCALATION + 5)).toBe(true);
  });
});

describe('the action-tier table', () => {
  it('gives every kind exactly one tier', () => {
    for (const kind of ACTION_KINDS) {
      expect(['AUTO', 'RECOMMEND', 'APPROVE'], kind).toContain(tierFor(kind));
    }
  });

  // THE RULE: do not let an AUTO action do anything a human would want to
  // review. Encoded as a list of what AUTO is allowed to be, so adding an
  // AUTO entry means changing this test on purpose.
  it('keeps AUTO to notifications and cleanup', () => {
    const auto = ACTION_KINDS.filter((kind) => tierFor(kind) === 'AUTO');
    expect([...auto].sort()).toEqual([
      'NOTIFY_DIAGNOSIS_CONFIRMED',
      'NOTIFY_ETA_CHANGED',
      'RELEASE_EXPIRED_HOLD',
    ]);
  });

  it('never lets a reassignment happen automatically', () => {
    for (const kind of ACTION_KINDS.filter((candidate) => candidate.startsWith('REASSIGN'))) {
      expect(tierFor(kind), kind).not.toBe('AUTO');
    }
  });

  it('blocks the commercial decisions behind sign-off', () => {
    expect(tierFor('ESCALATE_THRASHING_JOB')).toBe('APPROVE');
    expect(tierFor('CANCEL_JOB')).toBe('APPROVE');
  });

  // NOT APPROVE, deliberately. An APPROVE action blocks pending sign-off, so
  // tiering a late job that way would make it wait longer still — for a human
  // to acknowledge that it is late. Nothing about dispatch is gated on this
  // any more; feasibility stops filtering on a passed deadline on its own.
  it('does not block a late job behind sign-off', () => {
    expect(tierFor('ESCALATE_SLA_WINDOW_CLOSED')).toBe('RECOMMEND');
  });

  it('only executes AUTO immediately', () => {
    expect(executesImmediately('NOTIFY_ETA_CHANGED')).toBe(true);
    expect(executesImmediately('REASSIGN_AFTER_TRIGGER')).toBe(false);
    expect(executesImmediately('ESCALATE_SLA_WINDOW_CLOSED')).toBe(false);
  });
});
