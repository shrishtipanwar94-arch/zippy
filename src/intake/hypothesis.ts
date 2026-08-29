// Persisting the fault hypothesis: the probability distribution over faults,
// the capability set it implies, and its entropy. One row per revision — the
// first from the symptom payload, another after every answer — so the whole
// narrowing is replayable rather than being overwritten in place.
//
// The distribution is stored as JSON because it is a map of twelve floats read
// only as a whole. The two things anything else queries on — entropy and the
// required capability codes — are real columns.

import type { Prisma } from '@prisma/client';
import { FAULT_CODES } from '../domain/faults.js';
import type { FaultCode, FaultDistribution } from '../domain/faults.js';
import { normalise, shannonEntropy, topFault } from '../domain/entropy.js';
import { requiredCapabilities } from '../domain/capabilitySet.js';

export type StoredHypothesis = {
  id: string;
  version: number;
  distribution: FaultDistribution;
  entropy: number;
  topFault: FaultCode;
  requiredCapabilityCodes: string[];
};

// A stored JSON blob back into a distribution. Codes the blob is missing are
// treated as zero and the result is renormalised, so a distribution written by
// an older fault catalogue still loads instead of poisoning the maths with
// undefined.
function toDistribution(stored: unknown): FaultDistribution {
  const raw = (stored ?? {}) as Record<string, unknown>;
  const weights = {} as Record<FaultCode, number>;
  const uniform = {} as FaultDistribution;

  for (const fault of FAULT_CODES) {
    const value = raw[fault];
    weights[fault] = typeof value === 'number' && value > 0 ? value : 0;
    uniform[fault] = 1 / FAULT_CODES.length;
  }

  return normalise(weights, uniform);
}

export async function recordHypothesis(
  db: Prisma.TransactionClient,
  jobId: string,
  distribution: FaultDistribution,
): Promise<StoredHypothesis> {
  const previous = await db.faultHypothesis.findFirst({
    where: { jobId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const entropy = shannonEntropy(distribution);
  const capabilities = requiredCapabilities(distribution);
  const leading = topFault(distribution);

  const created = await db.faultHypothesis.create({
    data: {
      jobId,
      version: (previous?.version ?? -1) + 1,
      distribution,
      requiredCapabilityCodes: capabilities,
      entropy,
      topFault: leading,
    },
    select: { id: true, version: true },
  });

  return {
    id: created.id,
    version: created.version,
    distribution,
    entropy,
    topFault: leading,
    requiredCapabilityCodes: capabilities,
  };
}

export async function latestHypothesis(
  db: Prisma.TransactionClient,
  jobId: string,
): Promise<StoredHypothesis | null> {
  const row = await db.faultHypothesis.findFirst({
    where: { jobId },
    orderBy: { version: 'desc' },
  });
  if (!row) return null;

  return {
    id: row.id,
    version: row.version,
    distribution: toDistribution(row.distribution),
    entropy: row.entropy,
    topFault: (row.topFault ?? FAULT_CODES[0]) as FaultCode,
    requiredCapabilityCodes: row.requiredCapabilityCodes,
  };
}
