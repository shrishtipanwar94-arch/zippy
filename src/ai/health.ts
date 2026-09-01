// IS THE AI THERE? — one row, one component, visible to an operator.
//
// INVARIANT 8: every degraded state is visible. A silently absent extractor
// looks exactly like a system where every driver happens to prefer tapping
// buttons, and the difference matters — one is a product, the other is an
// outage. So every extraction attempt moves this row, GET /health reports it,
// and the driver's page shows a banner.
//
// ONE COMPONENT, NOT A LADDER. Phase 17 builds the full degradation ladder
// across every dependency and the transitions between NORMAL, DEGRADED and
// CRITICAL. This is the AI's single row of it, written now because the phase
// that introduces a dependency is the phase that owes the operator visibility
// of it.
//
// LAST WRITE WINS, deliberately. Two intake requests can finish at the same
// moment with different verdicts; the later one is the more recent truth about
// the service, and there is nothing to reconcile. `since` only moves when the
// state actually changes, so an operator can see how long it has been down
// rather than how long ago the last request was.

import type { HealthState, PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import type { ExtractionOutcome } from './extractSymptoms.js';

export const AI_COMPONENT = 'AI_EXTRACTION';

export async function recordAiHealth(
  db: PrismaClient,
  state: HealthState,
  detail: string,
): Promise<void> {
  const existing = await db.systemHealthState.findUnique({
    where: { component: AI_COMPONENT },
    select: { state: true },
  });

  if (existing?.state !== state) {
    logger.warn({ component: AI_COMPONENT, from: existing?.state ?? null, to: state, detail },
      'ai extraction health changed');
  }

  await db.systemHealthState.upsert({
    where: { component: AI_COMPONENT },
    update: { state, detail, ...(existing?.state === state ? {} : { since: new Date() }) },
    create: { component: AI_COMPONENT, state, detail },
  });
}

// The verdict an outcome implies. A schema-invalid reply is DEGRADED as surely
// as a refused connection is: in both cases the driver ends up on the picker,
// and an operator who sees "NORMAL" while every driver is being handed the
// fallback has been told something false.
export async function recordOutcomeHealth(
  db: PrismaClient,
  outcome: ExtractionOutcome,
): Promise<void> {
  if (outcome.status === 'EXTRACTED') {
    await recordAiHealth(db, 'NORMAL', `extracted in ${outcome.totalLatencyMs}ms`);
    return;
  }
  await recordAiHealth(db, 'DEGRADED', `${outcome.reason}: ${outcome.detail}`);
}

export async function currentAiHealth(db: PrismaClient): Promise<{
  state: HealthState;
  detail: string | null;
  since: Date | null;
}> {
  const row = await db.systemHealthState.findUnique({
    where: { component: AI_COMPONENT },
    select: { state: true, detail: true, since: true },
  });
  // Never asked is not the same as broken. A process that has taken no intake
  // yet reports NORMAL with no detail, and the first request tells the truth.
  if (!row) return { state: 'NORMAL', detail: null, since: null };
  return row;
}
