import { defineConfig } from 'vitest/config';

// THE CONCURRENCY SUITE — invariant 9, on its own config.
//
// Separate from vitest.config.ts because these tests want the opposite of what
// the default suite wants: a real Postgres container instead of a shared
// database, minutes of timeout instead of seconds, and one file at a time
// instead of parallel workers. Two suites with genuinely different needs get
// two configs rather than one config full of conditionals.
export default defineConfig({
  test: {
    include: ['tests/concurrency/**/*.test.ts'],
    environment: 'node',
    // Pulling an image and running migrations dominates the first run.
    testTimeout: 120_000,
    hookTimeout: 300_000,
    // ONE FILE AT A TIME. Parallel files would each start their own container
    // and, worse, would make "how many holds succeeded" depend on what another
    // file was doing to the same rows.
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/zippy_test?schema=public',
      REDIS_URL: 'redis://localhost:6379',
      PUBLIC_URL: 'http://localhost:3000',
      WS_ORIGIN: 'http://localhost:3000',
      CORS_ORIGINS: 'http://localhost:3000',
      LOG_LEVEL: 'silent',
      JWT_ACCESS_SECRET: 'test-access-secret-0000000000000000',
      JWT_REFRESH_SECRET: 'test-refresh-secret-1111111111111111',
      JWT_ACCESS_TTL: '15m',
      JWT_REFRESH_TTL: '7d',
      // NO MODEL CALLS FROM THE TEST SUITE. dotenv has already loaded the
      // developer's .env by the time config.ts is imported, so this is what
      // stops a real key there from turning the fast suite into a billable,
      // non-deterministic integration test against a provider. An empty value
      // reads as "not configured" (src/infra/config.ts).
      LLM_API_KEY: '',
      // RAZORPAY, PINNED THE SAME WAY AND FOR A STRONGER REASON. The keys below
      // are fake but well-formed, so `isRazorpayConfigured()` is true and every
      // adapter path is reachable in the fast suite; the BASE URL points at a
      // port nothing listens on, so any call a test forgot to fake fails
      // instantly with a connection refused rather than reaching
      // api.razorpay.com. A developer's real test-mode keys in .env are
      // overridden here for exactly the reason LLM_API_KEY is: a test suite
      // that talks to a vendor is neither reproducible nor free.
      RAZORPAY_KEY_ID: 'rzp_test_suite',
      RAZORPAY_KEY_SECRET: 'test-key-secret',
      RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret',
      RAZORPAY_API_BASE_URL: 'http://127.0.0.1:9',
      RAZORPAY_PAYOUT_ACCOUNT_NUMBER: '0000000000000000',
    },
  },
});
