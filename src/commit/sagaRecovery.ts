// CRASH RECOVERY — the routine that stops a dead process leaving a unit held
// forever.
//
// A saga is three legs acquired one at a time, and the process can die between
// any two of them. Nothing in Postgres rolls that back, because the legs are
// committed on purpose: leg 1 has to be durable or leg 2 would be offering a
// unit nobody reserved. So the state on disk after a crash is legitimate,
// partial, and nobody's job to finish — until this runs at startup.
//
// THE RULE, and it is deliberately blunt: ALL_ACCEPTED sagas are committed,
// and every other non-terminal saga is compensated. A saga interrupted
// mid-acquisition cannot be safely resumed — the process that was going to
// send leg 3 is gone, and the technician's phone has no idea it was ever part
// of anything — so the honest move is to let the unit go and re-plan, not to
// guess where it got to.
//
// WHY IT ONLY TOUCHES STALE SAGAS. In a two-process deployment, one process
// restarting must not compensate the other's live reservations. A saga younger
// than the hold TTL is still plausibly in flight and is left alone; one older
// than that has outlived the claim it rests on, so nobody is waiting on it any
// more. That is a heuristic, not a lock, and it is the weakest part of this
// file — a genuine distributed lock or an owner column would be stronger, and
// neither exists yet.

import type { PrismaClient, SagaState } from '@prisma/client';
import { DEFAULT_HOLD_TTL_MS } from './holds.js';
import { commitSaga, compensateSaga, TERMINAL_STATES } from './saga.js';

export type RecoveryOutcome = {
  sagaId: string;
  from: SagaState;
  to: SagaState;
};

export type RecoverInput = {
  // A saga younger than this is assumed to belong to a live process.
  staleAfterMs?: number;
  now?: Date;
};

export async function recoverSagas(
  db: PrismaClient,
  input: RecoverInput = {},
): Promise<RecoveryOutcome[]> {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_HOLD_TTL_MS;
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleAfterMs);

  const stranded = await db.dispatchOffer.findMany({
    where: {
      state: { notIn: TERMINAL_STATES },
      proposedAt: { lt: cutoff },
    },
    select: { id: true, state: true },
    orderBy: { proposedAt: 'asc' },
  });

  const outcomes: RecoveryOutcome[] = [];

  for (const saga of stranded) {
    // Both branches are idempotent, so a second recovery pass — or a live
    // response arriving at the same moment — finds nothing left to do rather
    // than doing it twice.
    const to =
      saga.state === 'ALL_ACCEPTED'
        ? await commitSaga(db, saga.id)
        : await compensateSaga(db, {
            sagaId: saga.id,
            reason: `recovered at startup from ${saga.state}`,
          });

    outcomes.push({ sagaId: saga.id, from: saga.state, to });
  }

  return outcomes;
}
