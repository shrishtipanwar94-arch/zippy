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
