// WHERE THE LADDER'S CURRENT POSITION IS KEPT — one row per component in
// `system_health_states`, and the roll-up read back out of them.
//
// EVERY TRANSITION IS LOGGED, and only transitions are. A probe running every
// fifteen seconds writes the same verdict ninety-five times out of a hundred;
// logging all of them would bury the four lines anybody wants — the moment it
// went down and the moment it came back. `since` moves for the same reason and
// answers the same question: how long has it been like this.
//
// LAST WRITE WINS. Two probes finishing at the same instant with different
// verdicts is not a conflict to reconcile — the later one is the more recent
// truth about the service. See this phase's concurrency notes.

import type { HealthState, PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';
import {
  HEALTH_COMPONENTS,
  describeMode,
  isHealthComponent,
  ladderEntry,
  systemMode,
} from '../domain/healthLadder.js';
import type { ComponentReading, HealthComponent } from '../domain/healthLadder.js';

export async function recordComponentHealth(
  db: PrismaClient,
  component: HealthComponent,
  state: HealthState,
  detail: string,
): Promise<boolean> {
  const existing = await db.systemHealthState.findUnique({
    where: { component },
    select: { state: true },
  });

  const changed = existing?.state !== state;
  if (changed) {
    logger.warn(
      { component, from: existing?.state ?? null, to: state, detail },
      'health state changed',
    );
  }

  await db.systemHealthState.upsert({
    where: { component },
    update: { state, detail, ...(changed ? { since: new Date() } : {}) },
    create: { component, state, detail },
  });

  return changed;
}

// Every component in the ladder, whether or not it has a row yet. A component
// nobody has probed is NORMAL rather than absent: "never asked" and "broken"
// are different, and only one of them is worth a banner.
export async function readComponentStates(db: PrismaClient): Promise<ComponentReading[]> {
  const rows = await db.systemHealthState.findMany({
    select: { component: true, state: true, detail: true },
  });

  const byComponent = new Map<string, { state: HealthState; detail: string | null }>();
  for (const row of rows) {
    if (isHealthComponent(row.component)) {
      byComponent.set(row.component, { state: row.state, detail: row.detail });
    }
  }

  return HEALTH_COMPONENTS.map((component) => ({
    component,
    state: byComponent.get(component)?.state ?? ('NORMAL' as HealthState),
    detail: byComponent.get(component)?.detail ?? null,
  }));
}

export type SystemHealth = {
  mode: HealthState;
  // The banner text, worded on the server. See describeMode.
  message: string;
  components: Array<ComponentReading & { label: string; fallback: string }>;
};

export async function readSystemHealth(db: PrismaClient): Promise<SystemHealth> {
  const readings = await readComponentStates(db);
  const mode = systemMode(readings);
  const degraded = readings.filter((reading) => reading.state !== 'NORMAL');

  return {
    mode,
    message: describeMode(mode, degraded),
    components: readings.map((reading) => ({
      ...reading,
      label: ladderEntry(reading.component).label,
      fallback: ladderEntry(reading.component).fallback,
    })),
  };
}
