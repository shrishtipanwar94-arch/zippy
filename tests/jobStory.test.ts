// A JOB'S LIFE AS SENTENCES.
//
// The append-only log was already complete — that is the expensive part and it
// was done. These tests pin the cheap part: that the rows read as a story, that
// a payload which changed shape costs a sentence its detail rather than
// throwing inside a panel, and that the demo time control explains itself on
// the timeline it deliberately does not rewrite.

import { describe, expect, it } from 'vitest';
import { sentenceFor, tellJobStory } from '../src/domain/jobStory.js';

describe('telling a job story', () => {
  it('reads as sentences in the order the server sequenced them', () => {
    const story = tellJobStory([
      // Deliberately out of order: sequence is the server's ordering and the
      // caller should not have to sort before asking.
      { sequence: 3, eventType: 'TECHNICIAN_OFFER_ACCEPTED', payload: {}, at: new Date() },
      { sequence: 1, eventType: 'JOB_CREATED', payload: {}, at: new Date() },
      {
        sequence: 2,
        eventType: 'TECHNICIAN_OFFER_SENT',
        payload: { technicianId: 'tech-07' },
        at: new Date(),
      },
    ]);

    expect(story.map((line) => line.sentence)).toEqual([
      'Reported',
      'Offered to tech-07',
      'Technician accepted',
    ]);
    expect(story.map((line) => line.sequence)).toEqual([1, 2, 3]);
  });

  it('puts the detail worth having into the sentence', () => {
    expect(
      sentenceFor({
        sequence: 1,
        eventType: 'SAFETY_TRIAGED',
        payload: { level: 'HIGH_RISK', reasonCodes: ['ON_HIGHWAY', 'NIGHT_AND_ALONE'] },
        at: new Date(),
      }),
    ).toBe('Triaged HIGH_RISK on 2 risk factors');

    expect(
      sentenceFor({
        sequence: 2,
        eventType: 'SAFETY_LEVEL_CHANGED',
        payload: { from: 'NORMAL', to: 'HIGH_RISK' },
        at: new Date(),
      }),
    ).toBe('Driver escalated it NORMAL to HIGH_RISK');

    expect(
      sentenceFor({
        sequence: 3,
        eventType: 'NO_FEASIBLE_PLAN',
        payload: { breakdown: 'NO_TECHNICIAN_ON_SHIFT x23, SLA_UNREACHABLE x1' },
        at: new Date(),
      }),
    ).toBe('No crew could take it: NO_TECHNICIAN_ON_SHIFT x23, SLA_UNREACHABLE x1');
  });

  it('degrades to the plain sentence when a payload has nothing to say', () => {
    // A payload that changed shape must cost the sentence its detail and never
    // throw: this renders inside a panel showing a whole job, and one bad row
    // would take the rest of the story with it.
    for (const payload of [null, undefined, 'not an object', {}, { level: 42 }]) {
      expect(
        sentenceFor({ sequence: 1, eventType: 'SAFETY_TRIAGED', payload, at: new Date() }),
      ).toBe('Triaged for safety');
    }
  });

  it('says one risk factor rather than 1 risk factors', () => {
    expect(
      sentenceFor({
        sequence: 1,
        eventType: 'SAFETY_TRIAGED',
        payload: { level: 'ELEVATED', reasonCodes: ['ON_HIGHWAY'] },
        at: new Date(),
      }),
    ).toBe('Triaged ELEVATED on 1 risk factor');
  });

  it('humanises an event type nobody has written copy for yet', () => {
    // driverUpdates.ts refuses to fall back at all, because a driver reading
    // DISPATCH_REQUEUED is the bug it exists to prevent. A dispatcher is a
    // different reader, and a phase adding an event type should not blank a
    // line of the story before somebody writes the copy.
    expect(
      sentenceFor({ sequence: 1, eventType: 'SOME_FUTURE_EVENT', payload: {}, at: new Date() }),
    ).toBe('Some future event');
  });

  it('explains the demo time control on the timeline it refuses to rewrite', () => {
    // ADVANCE_TIME ages the board but leaves job_events alone, because the
    // timeline is the truthful record. That leaves a job whose age no longer
    // matches its event times, and this line is what stops the gap looking
    // like a bug.
    expect(
      sentenceFor({
        sequence: 9,
        eventType: 'DEMO_TIME_ADVANCED',
        payload: { minutes: 40 },
        at: new Date(),
      }),
    ).toBe('Demo control: the board was aged 40 minutes');
  });

  it('carries the time through as an ISO string whatever it was given', () => {
    // The caller renders it — the server has no business guessing which
    // timezone the reader is sitting in.
    const at = new Date('2026-09-08T14:02:00.000Z');
    const [fromDate] = tellJobStory([
      { sequence: 1, eventType: 'JOB_CREATED', payload: {}, at },
    ]);
    const [fromString] = tellJobStory([
      { sequence: 1, eventType: 'JOB_CREATED', payload: {}, at: at.toISOString() },
    ]);
    expect(fromDate!.at).toBe('2026-09-08T14:02:00.000Z');
    expect(fromString!.at).toBe('2026-09-08T14:02:00.000Z');
  });
});
