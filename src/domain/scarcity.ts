// CAPABILITY SCARCITY — how thin the fleet is on each skill, and when that
// becomes an operational problem.
//
// THE NUMBER THAT MATTERS IS CREWED PAIRS, NOT UNITS OR TECHNICIANS.
// "3 flatbeds" and "6 flatbed-certified technicians" both overstate capacity
// if the certified crews are not sitting in the flatbeds. A capability is
// available for dispatch only where a unit carrying it and a technician
// certified in it are the same crew — the intersection candidates.ts computes
// when it builds an option. So this module reports the pair count as the
// operative figure and the two component counts as context for why it is what
// it is.
//
// Pure: counts and thresholds in, a level out. No Prisma, no clock.

export type ScarcityLevel = 'ok' | 'amber' | 'red';

// Share of the on-shift fleet that can do a thing, below which an operator
// should be looking at it. Hand-set, like every other threshold in this
// project, and stated as such: nothing has been measured about how thin is too
// thin. What makes them defensible is that they are RATIOS rather than counts,
// so they mean the same thing for a fleet of 24 and a fleet of 240.
export const RED_SHARE = 0.1;
export const AMBER_SHARE = 0.25;

// A capability nothing can do at all is red regardless of fleet size — a ratio
// alone would call 0/1 and 0/100 equally catastrophic, which is right, but it
// would also let a one-unit fleet look fine at 1/1 while carrying no
// redundancy. Both edges are handled explicitly rather than emerging from the
// arithmetic.
export function classifyShare(available: number, total: number): ScarcityLevel {
  if (available === 0) return 'red';
  if (total === 0) return 'red';

  const share = available / total;
  if (share < RED_SHARE) return 'red';
  if (share < AMBER_SHARE) return 'amber';

  // Fewer than two crews is a single point of failure whatever the ratio says:
  // one technician calling in sick takes the capability to zero.
  if (available < 2) return 'amber';
  return 'ok';
}

export type CapabilityScarcity = {
  code: string;
  // Crews (unit + technician) that can actually perform this. The number a
  // dispatcher should read first.
  crewedPairs: number;
  // The two halves, for explaining the pair count.
  unitsWithCapability: number;
  techniciansWithCapability: number;
  totalCrewedUnits: number;
  totalTechnicians: number;
  level: ScarcityLevel;
};

export function summarise(input: {
  code: string;
  crewedPairs: number;
  unitsWithCapability: number;
  techniciansWithCapability: number;
  totalCrewedUnits: number;
  totalTechnicians: number;
}): CapabilityScarcity {
  return { ...input, level: classifyShare(input.crewedPairs, input.totalCrewedUnits) };
}

// Worst first, so the panel does not need to sort and an operator reads the
// problem before the padding. Ties break on the code so the order is stable
// across renders — a list that reshuffles on every poll is unreadable.
const LEVEL_ORDER: Record<ScarcityLevel, number> = { red: 0, amber: 1, ok: 2 };

export function byUrgency(a: CapabilityScarcity, b: CapabilityScarcity): number {
  const level = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
  if (level !== 0) return level;
  const pairs = a.crewedPairs - b.crewedPairs;
  if (pairs !== 0) return pairs;
  return a.code.localeCompare(b.code);
}
