// src/engine/allocation.ts — the hand-written Hungarian algorithm.
//
// The load-bearing test here is the brute-force comparison: for small
// matrices every permutation is enumerated and the true minimum computed
// directly, then compared against what the algorithm returned. An assignment
// algorithm that is subtly wrong still returns a plausible-looking answer, so
// "it produced an assignment" proves nothing — only "it produced THE cheapest
// assignment, checked exhaustively" does.

import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_COST, hungarian, solveAssignment } from '../src/engine/allocation.js';

// Every way to pick one distinct column per row, scored. O(cols!) — only ever
// called on tiny matrices.
function bruteForceMinimum(cost: number[][]): number {
  const rows = cost.length;
  const cols = cost[0]!.length;
  let best = Number.POSITIVE_INFINITY;

  const used = new Array<boolean>(cols).fill(false);
  const walk = (row: number, total: number): void => {
    if (total >= best) return; // no cheaper completion is possible
    if (row === rows) {
      best = total;
      return;
    }
    for (let col = 0; col < cols; col += 1) {
      if (used[col]) continue;
      used[col] = true;
      walk(row + 1, total + cost[row]![col]!);
      used[col] = false;
    }
  };
  walk(0, 0);

  return best;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe('solveAssignment — correctness against brute force', () => {
  it('matches the true minimum on a hand-worked 3x3', () => {
    // Cheapest is row0->col1 (2) + row1->col0 (3) + row2->col2 (4) = 9.
    // The greedy choice (row0 takes its own minimum, col0 at 1) leads to 1 +
    // 8 + 4 = 13, so this matrix genuinely distinguishes the two.
    const cost = [
      [1, 2, 9],
      [3, 8, 7],
      [9, 6, 4],
    ];

    const result = solveAssignment(cost);
    expect(result.totalCost).toBe(9);
    expect(result.totalCost).toBe(bruteForceMinimum(cost));
  });

  it('agrees with brute force across many random square matrices', () => {
    const random = seededRandom(20260830);

    for (let trial = 0; trial < 200; trial += 1) {
      const size = 1 + (trial % 5); // 1x1 up to 5x5
      const cost = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => Math.floor(random() * 50)),
      );

      const result = solveAssignment(cost);
      expect(result.totalCost, `trial ${trial}, ${size}x${size}`).toBe(bruteForceMinimum(cost));
    }
  });

  it('agrees with brute force when there are more columns than rows', () => {
    const random = seededRandom(4242);

    for (let trial = 0; trial < 100; trial += 1) {
      const rows = 1 + (trial % 4);
      const cols = rows + 1 + (trial % 3);
      const cost = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => Math.floor(random() * 40)),
      );

      const result = solveAssignment(cost);
      expect(result.totalCost, `trial ${trial}, ${rows}x${cols}`).toBe(bruteForceMinimum(cost));
    }
  });

  it('never assigns one column to two rows', () => {
    const random = seededRandom(99);

    for (let trial = 0; trial < 100; trial += 1) {
      const size = 2 + (trial % 5);
      const cost = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => Math.floor(random() * 30)),
      );

      const assigned = solveAssignment(cost).assignedColumn.filter((col) => col !== null);
      expect(new Set(assigned).size).toBe(assigned.length);
    }
  });
});

describe('solveAssignment — the outcome greedy gets wrong', () => {
  // THE POINT OF THE WHOLE PHASE, as a two-job matrix. Only unit 0 can serve
  // job 1 at all. Job 0 marginally prefers unit 0 too — a greedy pass that
  // takes each job's own best in order strands job 1 entirely.
  it('gives up a marginal first-choice to keep the other job servable', () => {
    const cost = [
      [10, 11], // job 0: slightly prefers unit 0, but unit 1 works fine
      [20, UNAVAILABLE_COST], // job 1: only unit 0 is possible
    ];

    const result = solveAssignment(cost);

    expect(result.assignedColumn[0]).toBe(1); // job 0 took its second choice
    expect(result.assignedColumn[1]).toBe(0); // so job 1 could be served
    expect(result.totalCost).toBe(31);
  });

  it('leaves a job unassigned rather than pairing it with an unavailable cell', () => {
    const cost = [
      [5, UNAVAILABLE_COST],
      [7, UNAVAILABLE_COST],
    ];

    const result = solveAssignment(cost);
    const assigned = result.assignedColumn.filter((col) => col !== null);

    // Only one unit is usable at all, so exactly one job is served and the
    // other is reported as unassigned — not matched to the unavailable cell.
    expect(assigned).toHaveLength(1);
    expect(result.assignedColumn).toContain(null);
    // An unavailable cell must never be counted as a real cost.
    expect(result.totalCost).toBeLessThan(UNAVAILABLE_COST);
  });
});

describe('solveAssignment — padding when jobs outnumber units', () => {
  it('serves as many jobs as there are units and reports the rest unassigned', () => {
    const cost = [
      [4, 9],
      [6, 3],
      [5, 8],
    ];

    const result = solveAssignment(cost);
    const assigned = result.assignedColumn.filter((col) => col !== null);

    expect(assigned).toHaveLength(2);
    expect(result.assignedColumn.filter((col) => col === null)).toHaveLength(1);
    expect(new Set(assigned).size).toBe(2);
  });

  it('chooses WHICH jobs to strand by total cost, not by input order', () => {
    // One unit, three jobs. The unit should go to the job that uses it best.
    const cost = [[50], [2], [40]];

    const result = solveAssignment(cost);

    expect(result.assignedColumn[1]).toBe(0);
    expect(result.assignedColumn[0]).toBeNull();
    expect(result.assignedColumn[2]).toBeNull();
    expect(result.totalCost).toBe(2);
  });
});

describe('solveAssignment — degenerate shapes', () => {
  it('returns nothing for no jobs', () => {
    expect(solveAssignment([])).toEqual({ assignedColumn: [], totalCost: 0 });
  });

  it('reports every job unassigned when there are no units at all', () => {
    const result = solveAssignment([[], []]);
    expect(result.assignedColumn).toEqual([null, null]);
    expect(result.totalCost).toBe(0);
  });

  it('handles a single job and a single unit', () => {
    expect(solveAssignment([[7]])).toEqual({ assignedColumn: [0], totalCost: 7 });
  });

  // FOUND BY MUTATION. Deleting the padding step does not make a test fail —
  // it makes the algorithm spin forever, because with more rows than columns
  // the augmenting search never reaches an unmatched column. A hang is a far
  // worse failure than a wrong answer in a dispatch path: no error, no
  // timeout, no partial result, just a request that never returns. The
  // precondition is now checked explicitly, and this asserts it throws
  // quickly rather than hanging.
  it('throws on an unpadded matrix with more rows than columns rather than hanging', () => {
    expect(() => hungarian([[1], [2], [3]], 3, 1)).toThrow(/rows <= cols/);
  });

  it('is deterministic — the same matrix always produces the same assignment', () => {
    const cost = [
      [3, 3, 3],
      [3, 3, 3],
      [3, 3, 3],
    ];

    const first = solveAssignment(cost);
    const second = solveAssignment(cost);
    expect(first.assignedColumn).toEqual(second.assignedColumn);
  });
});
