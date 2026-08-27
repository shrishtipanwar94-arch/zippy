# Codemap

Where things live, the order to read them in, and the call paths that matter.
Updated at the same checkpoints as INTERVIEW.md (end of Phases 4, 9, 13, 17,
22). It is deliberately tiny right now — after Phase 0 there is only a health
check.

## 1. Where things live

```
src/index.ts              web process: builds the app, listens, shuts down cleanly
src/worker.ts             worker process: heartbeat only until BullMQ (Phase 5)
src/api/app.ts            builds the Express app (no listen) — request id, CORS, JSON, routes
src/api/health.ts         GET /health — real SELECT 1 + real PING, 503 when a dep is down
src/infra/config.ts       env parsed once through a Zod schema; process exits if invalid
src/infra/logger.ts       one pino JSON logger for the process
src/infra/db.ts           the single Prisma client (cached in dev to survive watch reloads)
src/infra/redis.ts        the single ioredis connection (cache/queues only, never holds)

src/domain/               empty — fault rules, job model (Phase 3+)
src/engine/               empty — candidates, feasibility, cost, allocation (Phase 6+); no db/redis imports
src/commit/               empty — holds and the reservation saga (Phase 11+)
src/workers/              empty — BullMQ processors (Phase 5+)

prisma/schema.prisma      datasource + generator only; no models until Phase 1
prisma/seed.ts            no-op until Phase 1; must stay idempotent

tests/health.test.ts      health endpoint degrades to 503, never throws
tests/concurrency/        empty — real-Postgres invariant tests (Phase 11+)

requests/health.http      version-controlled API calls (VS Code REST Client)
docker-compose.yml        postgres:16 + redis:7, healthchecks, named volumes
```

## 2. Reading order

1. `src/infra/config.ts` — nothing runs without valid env; start here.
2. `src/infra/logger.ts` — how output is structured.
3. `src/infra/db.ts` and `src/infra/redis.ts` — the two dependencies.
4. `src/api/app.ts` — how a request is wrapped (request id, CORS, JSON).
5. `src/api/health.ts` — the only real route; follow one `GET /health`.
6. `src/index.ts` — how the web process starts and stops.
7. `src/worker.ts` — the second process, empty for now but real.

That is the whole codebase after Phase 0. It grows here at each checkpoint.

## 3. Call paths

Only one exists so far:

```
GET /health
  → app.ts   pino-http assigns req.id
  → health.ts  checkDatabase()  → prisma.$queryRaw`SELECT 1`
               checkRedis()     → redis.ping()
  → 200 { status: "ok", ... }  when both succeed
  → 503 { status: "degraded", ... }  when either fails; process stays alive
```

The dispatch, diagnosis-change and saga-compensation call paths will be
added here once the code behind them exists.
