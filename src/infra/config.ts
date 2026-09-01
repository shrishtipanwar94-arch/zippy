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

  // HOW MUCH AN ESTIMATE MAY GROW BEFORE THE DRIVER IS ASKED AGAIN (Phase 15c).
  //
  // In basis points of the already-approved total — 1000 bps is 10% — because
  // money in this codebase is integers and a percentage stored as a float is a
  // rounding argument waiting to happen. The schema already uses bps for
  // `technicians.rating_bps`.
  //
  // Configurable because it is a commercial policy, not a fact: a workshop
  // chain that wants every rupee re-approved sets it to 0, and one that trusts
  // its technicians on small overruns sets it higher. 10% is a plausible
  // starting point and is not a measured figure.
  ESTIMATE_REAPPROVAL_TOLERANCE_BPS: z.coerce.number().int().min(0).default(1000),

  // THE PLATFORM'S CUT, in basis points of the job total — 2000 bps is 20%.
  // The marketplace's whole commercial model in one number, so it is
  // configurable rather than a literal buried in the ledger. Per-contract
  // commission is the obvious next want and would live on `Contract`.
  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(10_000).default(2000),

  // THE SMALLEST BALANCE WORTH A BANK TRANSFER. Below this a technician's
  // earnings roll forward to the next run rather than being sent — every
  // transfer costs the platform a fee and the technician a line on a statement,
  // and ₹500 is a plausible floor for a daily cycle. Configurable because it is
  // a commercial choice: a weekly cycle would want it higher, and a platform
  // absorbing transfer fees might set it to zero.
  PAYOUT_MINIMUM_PAISE: z.coerce.number().int().min(0).default(50_000),

  // THE LANGUAGE MODEL (Phase 16) — intake only, never a dispatch decision.
  //
  // OPTIONAL BY DESIGN, and this is invariant 8 rather than convenience: with
  // no key the extractor reports itself unavailable, the driver gets the
  // structured symptom picker, the banner says the system is degraded, and
  // every other part of dispatch behaves exactly as it did in Phase 3. A
  // required key would make an external service a startup dependency of a
  // system whose whole claim is that no external service sits on the decision
  // path (invariant 10).
  //
  // AN EMPTY STRING MEANS UNSET. `.env` is loaded before the test suite runs,
  // so a developer with a real key in it would otherwise have the fast suite
  // making live calls to a model provider — non-deterministic, billable, and
  // exactly what the degraded-path tests are there to prove does not happen.
  // The vitest configs pin this to '' for that reason.
  LLM_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  // WHICH WIRE PROTOCOL the key above speaks. Anthropic's Messages API, or the
  // OpenAI-compatible `POST /chat/completions` that Groq and most other
  // providers expose. Declared rather than sniffed from the key's prefix: a
  // provider guessed from a string is a provider that changes silently when
  // somebody rotates a credential.
  LLM_PROVIDER: z.enum(['anthropic', 'openai-compatible']).default('anthropic'),
  // Only read by the openai-compatible provider. Defaults to Groq because that
  // is what this deployment uses; any OpenAI-shaped endpoint works.
  LLM_BASE_URL: urlString('LLM_BASE_URL').default('https://api.groq.com/openai/v1'),
  LLM_MODEL: z.string().min(1).default('claude-opus-5'),
  // Short on purpose. A driver standing at the roadside waits on this call, so
  // a slow answer is worth less than a fast picker: past this we give up and
  // degrade rather than hold the screen.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
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
