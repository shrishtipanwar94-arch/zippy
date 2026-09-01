// PHASE 17 — the ladder, the escalation card, and the planner's deadline.
//
// Three claims are worth a test and the rest is wiring:
//
// 1. THE ROLL-UP CANNOT BE WRONG IN THE DANGEROUS DIRECTION. A component that
//    reports CRITICAL when its ladder entry says it can only cause DEGRADED
//    must not black out the console — a broken symptom assistant is not a
//    broken dispatcher, and an operator who learns to ignore a red banner is
//    the real failure.
// 2. UNSERVICEABLE PRODUCES A CARD WITH A REAL REASON CODE, never a blank
//    screen. That is the phase's own check.
// 3. THE DEADLINE STOPS WORK AND SAYS SO. A plan that was cut short must be
//    distinguishable from a plan that ran to completion, or "why was this job
//    not planned" has no answer.
//
// Pure functions only — no database, no network. The route-level proof that
// the switches move the ladder lives in tests/chaosRoutes.test.ts.

import { describe, expect, it } from 'vitest';
import { describeMode, ladderEntry, systemMode } from '../src/domain/healthLadder.js';
import type { ComponentReading } from '../src/domain/healthLadder.js';
import { buildEscalationCard } from '../src/domain/escalationCard.js';
import type { RejectedOptionView } from '../src/domain/escalationCard.js';

function reading(
  component: ComponentReading['component'],
  state: ComponentReading['state'],
): ComponentReading {
  return { component, state, detail: null };
}

function rejection(overrides: Partial<RejectedOptionView>): RejectedOptionView {
  return {
    unitId: 'unit-1',
    unitCode: 'VAN-01',
    technicianName: 'A Technician',
    code: 'CAPABILITY_MISSING',
    detail: 'missing EV_HV_CERTIFICATION',
    travelMinutes: 12,
    missingCapabilities: ['EV_HV_CERTIFICATION'],
    ...overrides,
  };
}

describe('the ladder rolls up', () => {
  it('is NORMAL when everything is', () => {
    expect(systemMode([reading('AI_EXTRACTION', 'NORMAL'), reading('GPS', 'NORMAL')])).toBe('NORMAL');
  });

  it('is DEGRADED when any component is', () => {
    expect(systemMode([reading('AI_EXTRACTION', 'DEGRADED'), reading('GPS', 'NORMAL')])).toBe(
      'DEGRADED',
    );
  });

  it('is CRITICAL only when automatic dispatch is down', () => {
    expect(systemMode([reading('DISPATCH_CORE', 'CRITICAL')])).toBe('CRITICAL');
  });

  it('refuses to let a lesser component claim CRITICAL', () => {
    // A probe bug, or a future component that reports the wrong severity. The
    // symptom assistant being gone can never mean the dispatcher is down —
    // drivers still get help through the picker.
    expect(systemMode([reading('AI_EXTRACTION', 'CRITICAL')])).toBe('DEGRADED');
    expect(systemMode([reading('PAYMENTS', 'CRITICAL')])).toBe('DEGRADED');
  });

  it('words the banner without an enum in it', () => {
    const message = describeMode('DEGRADED', [reading('AI_EXTRACTION', 'DEGRADED')]);

    expect(message).toContain(ladderEntry('AI_EXTRACTION').label);
    expect(message).not.toContain('AI_EXTRACTION');
    expect(message).not.toContain('DEGRADED');
  });

  it('says what still works when dispatch is down, rather than that it is down', () => {
    const message = describeMode('CRITICAL', [reading('DISPATCH_CORE', 'CRITICAL')]);
    expect(message).toContain('by hand');
    expect(message).toContain('audited');
  });
});

describe('the escalation card', () => {
  it('names the code the most options failed on', () => {
    const card = buildEscalationCard('job-1', [
      rejection({ code: 'CAPABILITY_MISSING' }),
      rejection({ code: 'CAPABILITY_MISSING', unitId: 'unit-2' }),
      rejection({ code: 'SLA_UNREACHABLE', unitId: 'unit-3' }),
    ]);

    expect(card.reasonCode).toBe('CAPABILITY_MISSING');
    expect(card.reason).toContain('skill');
  });

  it('is never a blank screen, even when nothing was considered', () => {
    const card = buildEscalationCard('job-1', []);

    expect(card.reasonCode).toBe('UNIT_UNAVAILABLE');
    expect(card.reason.length).toBeGreaterThan(0);
    expect(card.recommendation.length).toBeGreaterThan(0);
    expect(card.alternative.length).toBeGreaterThan(0);
    expect(card.actions).toHaveLength(3);
  });

  it('prefers the option a human could actually clear over the merely nearest', () => {
    const card = buildEscalationCard('job-1', [
      // Two minutes away and physically unable to do the job.
      rejection({ unitId: 'near', code: 'VEHICLE_TYPE_INCOMPATIBLE', travelMinutes: 2 }),
      // Twenty minutes away and only waiting on a technician to come on shift.
      rejection({ unitId: 'far', code: 'NO_TECHNICIAN_ON_SHIFT', travelMinutes: 20 }),
    ]);

    expect(card.closest?.unitId).toBe('far');
    expect(card.closestExplanation).toContain('20 min away');
  });

  it('names the missing capabilities when that is why', () => {
    const card = buildEscalationCard('job-1', [
      rejection({ code: 'CAPABILITY_MISSING', missingCapabilities: ['EV_HV_CERTIFICATION'] }),
    ]);

    expect(card.closestExplanation).toContain('EV_HV_CERTIFICATION');
    expect(card.closestExplanation).toContain('A Technician');
  });

  it('offers all three actions whatever the reason', () => {
    for (const code of ['CAPABILITY_MISSING', 'SLA_UNREACHABLE', 'TENANT_CONTRACT_EXCLUDES'] as const) {
      const card = buildEscalationCard('job-1', [rejection({ code })]);
      expect(card.actions).toEqual(['APPROVE_ANYWAY', 'FIND_EXTERNAL_PROVIDER', 'CONTACT_DRIVER']);
    }
  });
});
