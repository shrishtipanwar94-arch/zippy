import 'dotenv/config';
import { z } from 'zod';

/**
 * ENVIRONMENT AS A CONTRACT
 *
 * Every value the process needs to run is declared here and validated once, at
 * startup, through a Zod schema. If a variable is missing or malformed the
 * process refuses to start rather than failing later with a confusing error
 * deep inside a request. This is the only place `process.env` is read.
 *
 * PUBLIC_URL / WS_ORIGIN / CORS_ORIGINS are localhost today, but they are
 * declared now so that deployment (Phase 26) is a config change, not a code
 * change.
 */

// Accepts any string that `new URL()` can parse. Kept deliberately simple so it
// behaves identically across validator library versions.
const urlString = (label: string) =>
  z.string().refine(
    (value) => {
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: `${label} must be a valid URL` },
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  DATABASE_URL: urlString('DATABASE_URL'),
  REDIS_URL: urlString('REDIS_URL'),

  PUBLIC_URL: urlString('PUBLIC_URL'),
  WS_ORIGIN: urlString('WS_ORIGIN'),
  // Comma-separated list of allowed browser origins.
  CORS_ORIGINS: z.string().min(1, 'CORS_ORIGINS must list at least one origin'),

  // Two separate secrets so a leaked access secret cannot mint refresh tokens.
  // Short access TTL, long refresh TTL — the refresh token is the only
  // long-lived credential and it is only ever sent to POST /auth/refresh.
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Self-hosted routing (Phase 6) — never a hosted maps API; see
  // src/infra/routing.ts for why. Defaults to the docker-compose service so
  // local dev needs no .env change. A dispatch decision must still work when
  // OSRM is unreachable, so every value below has a safe default and nothing
  // here is required.
  OSRM_URL: urlString('OSRM_URL').default('http://localhost:5001'),
  OSRM_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  // Straight-line distance is always shorter than the road distance; this
  // multiplier is the fallback's stand-in for "roads are not straight lines."
  // 1.4 is a common rule-of-thumb detour factor for a mixed urban/highway
  // network — not measured against Bengaluru specifically, and it is exactly
  // the kind of number that should move once real OSRM data is available to
  // check it against, which is the whole reason the fallback is marked
  // DEGRADED rather than trusted quietly.
  ROUTING_FALLBACK_ROAD_FACTOR: z.coerce.number().positive().default(1.4),
  // Assumed average speed once the road-factor distance is known. 30 km/h is
  // a conservative mixed city-traffic figure, not a measured one.
  ROUTING_FALLBACK_SPEED_KMH: z.coerce.number().positive().default(30),

  // ZONE PARTITIONING (Phase 9). Above this many candidate options in one
  // solve, the solver splits the jobs by zone and solves each zone
  // separately rather than as one matrix. The Hungarian algorithm is O(n^3),
  // so a single citywide matrix grows faster than the arrival rate does.
  // Deliberately configurable rather than hardcoded: Phase 10's harness
  // measures what the partitioning costs in decision quality, and that
  // measurement is only meaningful if the threshold can be moved.
  SOLVER_ZONE_PARTITION_THRESHOLD: z.coerce.number().int().positive().default(400),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    console.error('Invalid environment configuration. The process cannot start:');
    console.error(problems.join('\n'));
    process.exit(1);
  }

  const env = parsed.data;

  return {
    ...env,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}

export const config = loadConfig();
export type Config = typeof config;
