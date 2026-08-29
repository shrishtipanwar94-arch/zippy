// A SEEDED PSEUDO-RANDOM GENERATOR. `Math.random()` cannot be used anywhere in
// the simulator, because Phase 10's evaluation harness replays seeded scenarios
// and compares the results. If the same seed does not produce the same run,
// there is no harness, no measured number, and nothing defensible to claim.
//
// mulberry32: a small, fast, well-distributed 32-bit generator. It is not
// cryptographically secure and must never be used for tokens or ids — it is
// here because it is reproducible, which is the opposite requirement.
//
// Each generator carries its own state, so two simulator components drawing
// from separate streams cannot perturb each other's sequence.

export type Random = {
  // The next float in [0, 1).
  next: () => number;
  // An integer in [0, bound).
  nextInt: (bound: number) => number;
  // True with the given probability.
  chance: (probability: number) => boolean;
  // One item, uniformly.
  pick: <T>(items: readonly T[]) => T;
  // One key, chosen in proportion to its weight.
  pickWeighted: <T extends string>(weights: Record<T, number>) => T;
};

export function createRandom(seed: number): Random {
  // Any 32-bit state works; the seed is mixed so that adjacent seeds (1, 2, 3)
  // do not produce visibly similar streams.
  let state = (seed ^ 0x9e3779b9) >>> 0;

  function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function nextInt(bound: number): number {
    return Math.floor(next() * bound);
  }

  function chance(probability: number): boolean {
    return next() < probability;
  }

  function pick<T>(items: readonly T[]): T {
    return items[nextInt(items.length)]!;
  }

  function pickWeighted<T extends string>(weights: Record<T, number>): T {
    const keys = Object.keys(weights) as T[];
    let total = 0;
    for (const key of keys) {
      total += weights[key];
    }

    // Walk the keys subtracting each weight; the one that takes the running
    // target below zero is the pick. Standard roulette-wheel selection.
    let target = next() * total;
    for (const key of keys) {
      target -= weights[key];
      if (target < 0) return key;
    }
    // Only reachable through floating-point drift on the final key.
    return keys[keys.length - 1]!;
  }

  return { next, nextInt, chance, pick, pickWeighted };
}
