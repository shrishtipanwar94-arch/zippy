// WHY JOBS ARE UNASSIGNED, as the plan card says it.
//
// "10 job(s) unassigned" is the weakest-looking number on the dispatcher's
// screen and it is actually the strongest argument the project has: dispatch is
// hard here because capability is scarce and lumpy, not because the solver is
// bad. These tests pin the two things that make that claim trustworthy — the
// counts add up to the unassigned total, and every reason code the engine can
// produce has words.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeUnassigned, REJECTION_PHRASES } from '../public/js/panels/plans.js';

describe('the unassigned breakdown', () => {
  it('counts jobs rather than rejected options', () => {
    // The server's describeRejectionCounts counts OPTIONS for one job —
    // twenty-three units all off shift reads "x23". Here the useful unit is the
    // job, so one job refused by twenty-three units is one job.
    const rejected = [
      ...Array.from({ length: 23 }, () => ({ jobId: 'j1', code: 'NO_TECHNICIAN_ON_SHIFT' })),
      { jobId: 'j2', code: 'SLA_UNREACHABLE' },
    ];
    expect(describeUnassigned(['j1', 'j2'], rejected)).toBe(
      '1 capable units have no technician on shift · 1 unreachable within SLA',
    );
  });

  it('gives each job its single dominant reason and orders by how many', () => {
    const rejected = [
      { jobId: 'a', code: 'DESTINATION_EV_CLASS_MISMATCH' },
      { jobId: 'b', code: 'DESTINATION_EV_CLASS_MISMATCH' },
      { jobId: 'c', code: 'DESTINATION_EV_CLASS_MISMATCH' },
      // This job saw both, and SLA_UNREACHABLE is the more common of the two.
      { jobId: 'd', code: 'SLA_UNREACHABLE' },
      { jobId: 'd', code: 'SLA_UNREACHABLE' },
      { jobId: 'd', code: 'CAPABILITY_MISSING' },
    ];
    expect(describeUnassigned(['a', 'b', 'c', 'd'], rejected)).toBe(
      '3 no destination certified for the EV class · 1 unreachable within SLA',
    );
  });

  it('names contention as contention rather than inventing a reason code', () => {
    // A job with no rejections was not refused by anything — it lost a unit to
    // a higher-priority job. Calling that a feasibility code would be a lie
    // about why dispatch is hard, which is the one thing this line exists to
    // tell the truth about.
    expect(describeUnassigned(['lonely'], [])).toBe('1 lost a unit to a higher-priority job');
  });

  it('ignores rejections belonging to jobs the plan did assign', () => {
    const rejected = [
      { jobId: 'assigned-elsewhere', code: 'CAPABILITY_MISSING' },
      { jobId: 'j1', code: 'PART_UNAVAILABLE' },
    ];
    expect(describeUnassigned(['j1'], rejected)).toBe('1 the part is not in any van in range');
  });

  it('adds up to the unassigned count, always', () => {
    // The property that makes the line readable as "six of the ten": every
    // unassigned job lands in exactly one bucket, explained or not.
    const unassigned = ['a', 'b', 'c', 'd', 'e'];
    const rejected = [
      { jobId: 'a', code: 'SLA_UNREACHABLE' },
      { jobId: 'b', code: 'SLA_UNREACHABLE' },
      { jobId: 'c', code: 'CAPABILITY_MISSING' },
      // d and e were refused by nothing.
    ];
    const counts = describeUnassigned(unassigned, rejected)
      .split(' · ')
      .map((part: string) => Number(part.split(' ')[0]));
    expect(counts.reduce((total: number, n: number) => total + n, 0)).toBe(unassigned.length);
  });
});

// SAME ARRANGEMENT AS ACTION_LABELS. The console has no build step and cannot
// import the engine's types, so the phrase map is duplicated in the panel and
// this asserts it against the source of truth. Duplication a test catches beats
// a bundler.
describe('every rejection code the engine can produce has words', () => {
  const codes = rejectionCodesFromEngine();

  it('finds the codes to check against', () => {
    // If the union is ever restructured this test would silently pass on an
    // empty list, which is the failure mode a completeness test must not have.
    expect(codes.length).toBeGreaterThan(5);
  });

  it.each(rejectionCodesFromEngine())('has a phrase for %s', (code) => {
    expect(REJECTION_PHRASES[code], code).toBeTruthy();
    expect((REJECTION_PHRASES[code] ?? '').length, code).toBeGreaterThan(4);
  });

  it('carries no phrases for codes that do not exist', () => {
    const known = new Set(codes);
    expect(Object.keys(REJECTION_PHRASES).filter((key) => !known.has(key))).toEqual([]);
  });
});

function rejectionCodesFromEngine(): string[] {
  const source = readFileSync(join(process.cwd(), 'src/engine/feasibility.ts'), 'utf8');
  const block = source.slice(source.indexOf('export type RejectionCode ='));
  const body = block.slice(0, block.indexOf(';'));
  return [...body.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((match) => match[1]!);
}
