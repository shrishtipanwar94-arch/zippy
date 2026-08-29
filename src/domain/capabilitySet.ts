// From "what is probably wrong" to "what skill do we need to send".
//
// Dispatch never sees a fault code — it sees a capability set. This file is the
// translation, and it is where diagnosis stops mattering: once the top faults
// all need the same capability, asking more questions cannot change who gets
// sent, so intake stops. That is one of the three stop conditions in
// questionSelection.ts.
//
// We do not take only the single most likely fault. A distribution that is 55%
// flat battery and 40% failed battery should send someone who can do both —
// being wrong there means a second callout.

import { capabilitiesForFault } from './faults.js';
import type { FaultCode, FaultDistribution } from './faults.js';
import { rankFaults } from './entropy.js';

// Keep adding faults in descending probability until this much of the total
// probability is covered, then stop. 0.8 leaves the long tail out — a 2%
// possibility should not add an EV certification to the requirement.
const COVERAGE_MASS = 0.8;

// However thin the coverage, never require more than this many faults' worth of
// skills; past three the requirement is so wide no technician satisfies it.
const MAX_FAULTS_CONSIDERED = 3;

// The faults intake is still seriously entertaining, most likely first.
export function contendingFaults(distribution: FaultDistribution): FaultCode[] {
  const ranked = rankFaults(distribution);
  const contenders: FaultCode[] = [];
  let covered = 0;

  for (const fault of ranked) {
    contenders.push(fault);
    covered += distribution[fault];
    if (covered >= COVERAGE_MASS) break;
    if (contenders.length >= MAX_FAULTS_CONSIDERED) break;
  }

  return contenders;
}

// The union of what the contending faults need. Sorted so the stored array is
// stable across runs and two hypotheses can be compared with a string equality.
export function requiredCapabilities(distribution: FaultDistribution): string[] {
  const required = new Set<string>();
  for (const fault of contendingFaults(distribution)) {
    for (const capability of capabilitiesForFault(fault)) {
      required.add(capability);
    }
  }
  return [...required].sort();
}

// True when every contending fault needs exactly the same skills. At that point
// the answer to "who do we send" no longer depends on which of them it is, so
// more questions cannot change the dispatch decision.
export function capabilitySetIsStable(distribution: FaultDistribution): boolean {
  const contenders = contendingFaults(distribution);
  if (contenders.length <= 1) return true;

  const first = capabilitiesForFault(contenders[0]!).slice().sort().join(',');
  return contenders.every(
    (fault) => capabilitiesForFault(fault).slice().sort().join(',') === first,
  );
}
