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

const baseEnvSchema = z.object({
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
  // network — not measured against Delhi specifically, and it is exactly
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

  // THE RESERVATION'S TWO CLOCKS, and they are coupled.
  //
  // OFFER_TTL_MS is how long a technician's phone counts down before the offer
  // expires. HOLD_TTL_MS is how long the van stays held while that happens.
  // Defaults are the figures these were as module constants through Phases 11
  // and 12 — 45 seconds for somebody to answer a phone, two minutes before a
  // van is freed from a dispatcher who closed their laptop. Neither is measured.
  //
  // CONFIGURABLE BECAUSE A DEMO NEEDS A LONGER WINDOW THAN A BUSY BOARD DOES.
  // Forty-five seconds is right when a technician is working and wrong when
  // somebody is talking an audience through the screen. See DEMO.md.
  OFFER_TTL_MS: z.coerce.number().int().positive().default(45_000),
  HOLD_TTL_MS: z.coerce.number().int().positive().default(120_000),

  // THE DEPLOYED DEMO BOARD. When 'true', the web process runs ensureDemoBoard
  // after migrations on every boot (scripts/start-process.sh) and the worker
  // keeps the demo crews' shifts and stock current every fifteen minutes
  // (src/workers/demoRefresh.ts). Off by default, so the main seed, the tests
  // and local development never see any of it.
  DEMO_MODE: z.enum(['true', 'false']).default('false'),

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

  // HOW LONG A STOCK COUNT STAYS BELIEVABLE (Phase 18).
  //
  // Stock is a claim, not a fact: the number on a van is only as good as the
  // last time somebody looked in the back of it. These two thresholds turn the
  // AGE of that count into a confidence level — under the first it is
  // VERIFIED, between them AGEING, past the second UNVERIFIED.
  //
  // Two hours and eight hours are a shift's shape, not a measurement: a
  // technician who counted at the start of the morning is trustworthy for the
  // first couple of jobs and much less so by the end of the day. Configurable
  // because the right numbers depend on how busy a fleet is, and because
  // Phase 19 makes them load-bearing — UNVERIFIED stock will count as
  // unavailable, so moving these thresholds moves real dispatch decisions and
  // that has to be something the evaluation harness can vary.
  STOCK_VERIFIED_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(120),
  STOCK_AGEING_MAX_AGE_MINUTES: z.coerce.number().int().positive().default(480),

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

  // RAZORPAY (Phase 22b) — TEST MODE ONLY, and the schema is where that is
  // enforced rather than a comment somebody can ignore.
  //
  // OPTIONAL, for the same reason LLM_API_KEY is: with no keys the payment
  // provider stays the Phase 15c stub, every settlement rule still runs in the
  // fast suite, and nothing about dispatch changes. A required key would make
  // a payment vendor a startup dependency of a breakdown service.
  //
  // A LIVE KEY IS REFUSED AT STARTUP. Razorpay's own prefixes tell the two
  // apart — `rzp_test_` and `rzp_live_` — so "this project never moves real
  // money" is a validation rule the process enforces on itself, not a promise
  // in a README. Nothing in this codebase can lift it without an edit here
  // that would show up in a diff.
  RAZORPAY_KEY_ID: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined))
    .refine((value) => value === undefined || value.startsWith('rzp_test_'), {
      message: 'RAZORPAY_KEY_ID must be a test-mode key (rzp_test_...). Live mode is not supported.',
    }),
  RAZORPAY_KEY_SECRET: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  // A DIFFERENT SECRET FROM THE API SECRET, and Razorpay treats them
  // separately: this one is set per webhook endpoint in their dashboard and is
  // the only thing that proves a POST to /webhooks/razorpay came from them.
  RAZORPAY_WEBHOOK_SECRET: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  RAZORPAY_API_BASE_URL: urlString('RAZORPAY_API_BASE_URL').default('https://api.razorpay.com'),
  // Short, because a capture happens while a technician stands waiting for the
  // screen to say the job is done. A slow gateway becomes a reconciliation
  // problem, which we have a worker for, rather than a hung request.
  RAZORPAY_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  // The RazorpayX source account payouts are drawn from. Separate from the
  // Payments API entirely — different product, different account number — and
  // absent it the payout executor reports itself unconfigured instead of
  // guessing.
  RAZORPAY_PAYOUT_ACCOUNT_NUMBER: z
    .string()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
  // HOW LONG A PAYMENT MAY SIT IN A NON-TERMINAL STATE before reconciliation
  // asks the gateway what really happened. Long enough that a driver part-way
  // through a checkout is not chased, short enough that a lost write is found
  // in one sweep rather than one day.
  RECONCILIATION_STALE_AFTER_MINUTES: z.coerce.number().int().positive().default(10),
});

// HOW MUCH LONGER THE HOLD MUST LIVE THAN THE OFFER.
//
// An offer that outlives its hold is the worst shape these two can take: the
// technician's phone shows a live countdown, they press Accept, and the
// reservation fails because the van was already let go. `consumeHold` updates
// `WHERE status = 'ACTIVE' AND expires_at > now` and the cleanup sweep marks
// anything past its expiry EXPIRED_BY_SWEEP, so there is no recovery — the
// accept just loses.
//
// The margin covers the gap between the technician pressing Accept and
// `consumeHold` running: the request leaving a phone on a bad connection, and
// the three legs of the saga committing. Fifteen seconds is generous for that
// and is a CHOSEN figure, not a measured one. The shipped defaults clear it
// with room to spare — 120s against 45s + 15s.
export const ACCEPT_ROUND_TRIP_MARGIN_MS = 15_000;

// Exported so the startup rule can be tested without starting a process —
// `loadConfig` exits on failure, which a test cannot catch. Plain numbers in,
// a sentence or null out.
export function ttlPairProblem(offerTtlMs: number, holdTtlMs: number): string | null {
  const required = offerTtlMs + ACCEPT_ROUND_TRIP_MARGIN_MS;
  if (holdTtlMs >= required) return null;

  // BOTH NUMBERS AND THE TARGET, because the reader of this is somebody whose
  // process will not start and who needs to know which value to change and to
  // what — not merely that a rule exists.
  return (
    `OFFER_TTL_MS is ${offerTtlMs}ms and HOLD_TTL_MS is ${holdTtlMs}ms, but the ` +
    `hold must be at least ${required}ms (the offer plus a ` +
    `${ACCEPT_ROUND_TRIP_MARGIN_MS}ms margin for the accept to land). A hold ` +
    `that expires before the offer it covers means a technician accepts a job ` +
    `whose van has already been released, and the reservation fails with ` +
    `nothing to retry. Raise HOLD_TTL_MS or lower OFFER_TTL_MS.`
  );
}

// The cross-field rule lives here rather than inside either field, because it
// is about the PAIR and Zod validates fields in isolation. It reports through
// the same path every other problem does, so a bad pair refuses startup with
// the same message shape as a missing DATABASE_URL.
export const envSchema = baseEnvSchema.superRefine((env, ctx) => {
  const problem = ttlPairProblem(env.OFFER_TTL_MS, env.HOLD_TTL_MS);
  if (problem) {
    ctx.addIssue({ code: 'custom', path: ['HOLD_TTL_MS'], message: problem });
  }
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
    demoMode: env.DEMO_MODE === 'true',
    corsOrigins: env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  };
}

export const config = loadConfig();
export type Config = typeof config;
