// THE SWITCH BOARD — what a demo has broken on purpose.
//
// READ BY THE PRODUCTION CODE PATHS, WRITTEN ONLY BY A DEV BUILD'S ROUTES. The
// asymmetry is deliberate and is what keeps `src/api/chaos.ts` from having to
// exist in production for the rest of the system to compile: `isChaosOn` is a
// question anybody may ask and the answer in production is always false,
// because nothing can ever have written a row.
//
// FAILS TO "NOT BROKEN". Every read is wrapped so that a database hiccup while
// asking "is the LLM switched off" cannot itself break intake. A switch board
// that can take down the thing it is meant to be testing would be a poor joke.
//
// ONE ROW PER SWITCH, in Postgres, because the API process and the worker
// process both read this and Redis is one of the things it can switch off.

import type { PrismaClient } from '@prisma/client';
import { logger } from '../infra/logger.js';

// THE FOUR THINGS THAT STAY BROKEN UNTIL SOMEBODY UNBREAKS THEM. The other
// four controls the phase asks for — take a technician offline, break a unit
// mid-job, force a destination decline, inject jobs — are one-shot ACTIONS
// against real rows, not modes, and live in src/chaos/actions.ts. Confusing
// the two is how a demo ends up with a switch nobody can find the "off" for.
export const CHAOS_SWITCHES = [
  'LLM_DOWN',
  'REDIS_DOWN',
  'WEBSOCKET_DOWN',
  'SOLVER_TIMEOUT',
] as const;

export type ChaosSwitchName = (typeof CHAOS_SWITCHES)[number];

export function isChaosSwitchName(value: string): value is ChaosSwitchName {
  return (CHAOS_SWITCHES as readonly string[]).includes(value);
}

export async function setChaosSwitch(
  db: PrismaClient,
  name: ChaosSwitchName,
  enabled: boolean,
  detail: string | null,
): Promise<void> {
  await db.chaosSwitch.upsert({
    where: { name },
    update: { enabled, detail },
    create: { name, enabled, detail },
  });
  // Loud on purpose. Somebody reading the logs of a broken demo needs the
  // moment the breakage was introduced to be the most obvious line in them.
  logger.warn({ switch: name, enabled }, 'chaos switch changed');
}

export async function isChaosOn(db: PrismaClient, name: ChaosSwitchName): Promise<boolean> {
  try {
    const row = await db.chaosSwitch.findUnique({ where: { name }, select: { enabled: true } });
    return row?.enabled ?? false;
  } catch (error) {
    // See the header: a failure to read the switch board means "nothing is
    // switched off", never "everything is".
    logger.error({ err: error, switch: name }, 'could not read the chaos switch board');
    return false;
  }
}

export async function readChaosSwitches(
  db: PrismaClient,
): Promise<Array<{ name: ChaosSwitchName; enabled: boolean }>> {
  const rows = await db.chaosSwitch.findMany({ select: { name: true, enabled: true } });
  const byName = new Map(rows.map((row) => [row.name, row.enabled]));
  return CHAOS_SWITCHES.map((name) => ({ name, enabled: byName.get(name) ?? false }));
}

// Everything back to normal, in one call. The demo's undo button, and the
// answer to "a control that leaves the system stuck is the worst possible demo
// failure" — whatever state a walkthrough got into, this returns it.
export async function resetChaos(db: PrismaClient): Promise<void> {
  await db.chaosSwitch.updateMany({ where: { enabled: true }, data: { enabled: false } });
  logger.warn('chaos switches all reset');
}
