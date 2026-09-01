// TURNING A CONTESTED VAN INTO A QUESTION FOR A HUMAN.
//
// The solver names the contested resources (src/domain/contractContention.ts,
// reached from src/engine/solve.ts) and never resolves one. This is the write
// half: each contested unit becomes an APPROVE ActionRequest carrying BOTH
// costs, so a dispatcher is choosing between two priced options rather than
// rubber-stamping a decision already made.
//
// THE CARD IS RAISED ON THE JOB THAT LOST. That is the job whose fate is
// actually open — the winner already has a van in the plan — and it is the job
// a dispatcher will be asked about when somebody rings up.
//
// RAISED ONCE PER JOB, NOT ONCE PER SOLVE. The planner re-runs on every trigger
// (a new job, a decline, a move) and would otherwise stack an identical card on
// the same job every few seconds until somebody answered. So a job with a
// PENDING card of this kind is skipped: the question has been asked and is
// still waiting for its answer, and asking it louder does not help.

import type { PrismaClient } from '@prisma/client';
import type { ContestedResource } from '../domain/contractContention.js';
import { requestAction } from './actionRequests.js';

export type RaisedContention = { jobId: string; actionRequestId: string };

export async function raiseContentionApprovals(
  db: PrismaClient,
  contested: ContestedResource[],
): Promise<RaisedContention[]> {
  const raised: RaisedContention[] = [];

  for (const resource of contested) {
    const alreadyAsked = await db.actionRequest.findFirst({
      where: {
        jobId: resource.loserJobId,
        kind: 'APPROVE_CROSS_TENANT_CONTENTION',
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (alreadyAsked) continue;

    const outcome = await requestAction(db, {
      jobId: resource.loserJobId,
      kind: 'APPROVE_CROSS_TENANT_CONTENTION',
      reason: describe(resource),
      impact: {
        unitId: resource.unitId,
        winnerJobId: resource.winnerJobId,
        loserJobId: resource.loserJobId,
        contractJobId: resource.contractJobId,
        consumerJobId: resource.consumerJobId,
        safetyLevel: resource.safetyLevel,
        // Both priced under the same objective, which is what makes them
        // comparable — and what makes the card worth reading rather than a
        // notification that something happened.
        winnerCost: resource.winnerCost,
        loserCost: resource.loserCost,
      },
    });

    raised.push({ jobId: resource.loserJobId, actionRequestId: outcome.actionRequestId });
  }

  return raised;
}

// Written for the person who has to answer it, in the order they need it: what
// is scarce, who wants it, and which of the two is the contract.
function describe(resource: ContestedResource): string {
  const contractIsWinner = resource.contractJobId === resource.winnerJobId;
  return (
    `unit ${resource.unitId} is the best option for both job ${resource.winnerJobId} ` +
    `(cost ${resource.winnerCost.toFixed(1)}) and job ${resource.loserJobId} ` +
    `(cost ${resource.loserCost.toFixed(1)}), both at safety level ${resource.safetyLevel}. ` +
    `The plan gives it to the ${contractIsWinner ? 'contract' : 'consumer'} job. ` +
    'A contract job and a consumer job cannot be traded off without a person.'
  );
}
