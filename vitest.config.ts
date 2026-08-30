import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The concurrency suite starts a real Postgres container and takes tens of
    // seconds. It is run on its own (`npm run test:concurrency`, and its own
    // config) rather than on every save — excluded here so the default suite
    // stays fast enough to actually run constantly.
    exclude: ['**/node_modules/**', 'tests/concurrency/**'],
    environment: 'node',
    // Config validation reads process.env at import time and would exit the
    // process if a variable were missing. These localhost values let the suite
    // load without a .env file; tests that need real infrastructure (the
    // concurrency suite, from Phase 11) start their own containers.
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
    },
  },
});
