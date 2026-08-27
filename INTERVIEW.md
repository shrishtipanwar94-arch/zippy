# INTERVIEW.md

A living interview-prep document for the maintainer. It is maintained
automatically: one structured entry per phase goes into DECISIONS.log, and at
checkpoints (end of Phases 4, 9, 13, 17, 22) that log is consolidated in here
and cleared.

**State after Phase 0.** Almost nothing is built. Most sections below say
"not implemented" and that is the correct, honest answer. They fill in as the
phases land.

---

## 1. Project Overview

Zippy is a roadside breakdown dispatch system. The thesis: optimise expected
**time-to-resolution**, not time-to-arrival. The nearest technician often
cannot fix the fault — dispatching them is fast to arrive and slow to
resolve, because a second dispatch then has to happen. Zippy computes the
expected time for the fault to actually be fixed, including the cost of a
likely re-dispatch, and allocates against that.

After Phase 0 the repo is a foundation only: two processes, a validated
environment, structured logging, and a health check that really checks its
dependencies. No domain logic.

## 2. Architecture

- **Modular monolith**, two processes: `web` (`src/index.ts`) and `worker`
  (`src/worker.ts`). Separate processes from the start so they deploy and
  fail independently. The worker is a heartbeat until Phase 5.
- **Express** app built in `src/api/app.ts` (construction) and started in
  `src/index.ts` (listen), so routes can be tested without binding a port.
- **Postgres** via Prisma is the intended source of truth; **Redis** via
  ioredis is cache and queues only.
- `src/engine/` is reserved for pure allocation logic with no infrastructure
  imports. Empty for now.

## 3. Request Lifecycles

Only one request exists: `GET /health`. It runs `SELECT 1` against Postgres
and `PING` against Redis in parallel, and returns
`{ status, db, redis, uptime }` with a 200 only if both succeed, otherwise a
503. It never throws and never exits the process.

Job intake, dispatch and completion lifecycles: **not implemented**.

## 4. Database

**Not implemented.** `prisma/schema.prisma` contains a datasource and a
generator and no models. The full schema — users, vehicles, technicians,
units, jobs, events, dispatch, inventory, pricing, money, providers,
tenancy — arrives in Phase 1. Design rules already fixed: `JobEvent` and
`LedgerEntry` append-only and enforced in the database; a `version` column on
every row that can be raced; money in integer paise, never a float.

## 5. API Design

One route: `GET /health`. Conventions fixed for later: typed errors, an
idempotency key on every external-facing mutation, a `JobEvent` on every
state transition. REST over Express; no GraphQL.

## 6. Auth

**Not implemented.** Phase 2 adds JWT access/refresh, argon2id hashing, a
role → resource → action permission table behind a single `can()`, and
tenant scoping enforced at two layers (request middleware plus a Prisma
extension that filters every tenant-scoped query).

## 7. Backend Concepts Used

Only what Phase 0 actually exercises:

1. **Fail-fast configuration** — `src/infra/config.ts` parses `process.env`
   through a Zod schema once at startup and calls `process.exit(1)` on any
   missing or malformed variable, rather than failing later inside a request.
2. **Structured logging with a request id** — one pino JSON logger;
   pino-http assigns or echoes an `x-request-id` and creates a child logger
   per request so every line for that request is correlated.
3. **Real dependency health checks** — `GET /health` issues an actual
   `SELECT 1` and an actual `PING`; the status code is derived from the
   results, never hardcoded.
4. **Process separation** — `web` and `worker` are independent OS processes
   with their own entry points, signal handlers and shutdown paths.
5. **Graceful shutdown** — both processes handle SIGINT/SIGTERM, stop
   accepting work, drain, and exit; the web process force-exits after a
   timeout so a deploy cannot hang.

## 8. Engineering Problems

The interesting problems (expected-time-to-resolution as an objective,
entropy-driven intake questioning, the reservation saga, real-Postgres
concurrency proofs, the evaluation harness that imports the production
engine) are all **ahead**. Nothing to claim here yet.

## 9. Concurrency

**Not implemented.** No shared mutable state exists yet beyond the process-
level Prisma and Redis singletons. Optimistic locking on units and jobs,
the technician-offer race, and the testcontainers-backed concurrency suite
arrive in Phase 11.

## 10. Failure Handling

- The process survives a dependency outage: if Postgres or Redis is
  unreachable, `GET /health` returns 503 and the process keeps running.
- Redis errors are caught by an `error` listener so an unhandled event
  cannot crash the process; ioredis retries in the background.
- Both processes shut down cleanly on a signal.

Retries, dead-letter queues, compensations, saga recovery: **not implemented**.

## 11. Security

- Secrets live in `.env` only, which is gitignored. `.env.example` holds
  placeholders. Nothing before Phase 16 needs a real key.
- JSON body size is capped at 1 MB.
- CORS reflects an `Origin` only when it is on the configured allowlist.

Auth, rate limiting, input validation on real endpoints: **not implemented**.

## 12. Scaling

**Not a real topic yet.** The design intent: the web process scales
horizontally behind one origin; the worker scales on queue depth; Postgres is
the single source of truth; Redis carries queues and cache. No measurements
exist and none are claimed.

## 13. Design Decisions & Tradeoffs

Carried from `docs/STACK.md`:

- **Postgres over MongoDB** — version-checked conditional updates,
  transactional saga legs, an append-only ordered event log, a relational
  domain. Mongo needs a replica set for multi-document transactions.
- **Modular monolith over microservices** — `src/engine` has no DB imports,
  so allocation is a pure function over a snapshot, testable without
  infrastructure and importable by the harness.
- **No frontend build step** — the value is the backend; the discipline
  React would enforce is enforced by hand (one state object, one
  `render(state)` per panel).
- **Two processes from day one** — they deploy separately and fail
  differently.
- **Optimistic over pessimistic locking** — low contention, and a
  pessimistic lock would be held across an external actor's response time.
- **Self-hosted OSRM over a hosted maps API** — determinism; an external
  routing call makes seeded replay non-reproducible.
- **BullMQ over Kafka** — the workload is delayed jobs, retries and a
  debounce, not a log.

Tradeoff already accepted: choosing explainability over cleverness
everywhere, per the readability contract in `CLAUDE.md`.

## 14. Interview Questions

Questions the code can currently answer:

- *Why is `/health` not just `return 200`?* Because a hardcoded 200 tells a
  load balancer the process is up but says nothing about whether it can
  reach its database — `src/api/health.ts` runs a real `SELECT 1` and a real
  `PING` and returns 503 if either fails, while the process stays alive.
- *Why validate the environment at startup instead of when a value is
  used?* So a misconfiguration is a loud failure at boot, not a confusing
  error deep inside a request an hour later — see `src/infra/config.ts`.
- *Why are `web` and `worker` separate processes on day one?* Because they
  deploy and fail independently, and retrofitting that split after shared
  state has grown is expensive.

Deeper questions (the objective function, the saga, concurrency proofs) are
not yet answerable by the code.

## 15. Things An Interviewer Can Attack

**The project is barely built.** After Phase 0 there is no domain model, no
auth, no dispatch logic, no tests beyond the health check, and no evaluation
results. Every substantive claim in this document is still a plan. The only
defensible statements are about the foundation: the process refuses to start
on bad config, it survives a dependency outage, and the two processes are
genuinely separate.

## 16. How I Would Improve It

Too early for meaningful improvements. The immediate next steps are the
phases themselves: the schema and an uneven seed (Phase 1), then auth and
tenant isolation (Phase 2).

## 17. Defensible Resume Claims

Currently **NONE**. Nothing here has been built to a depth, or measured to a
degree, that belongs on a resume. This section fills in only as features are
implemented and, where they involve numbers, measured.

## 18. Technical Vocabulary

- **Time-to-resolution vs time-to-arrival** — resolution is when the fault
  is fixed; arrival is when someone shows up. Zippy optimises the first.
- **Fail-fast configuration** — validate all config at startup and refuse to
  boot if it is wrong.
- **Graceful shutdown** — on a termination signal, stop taking new work,
  finish or requeue in-flight work, then exit.
- **Liveness vs readiness** — liveness is "the process is running";
  readiness is "the process can serve traffic". `/health` here is closer to
  readiness because it checks dependencies.
- **Optimistic locking** — detect a write conflict with a version check
  instead of holding a row lock. (Used from Phase 11.)

## 19. Current Project State

**Phase 0 complete.** Present and working:

- Project structure, locked stack, TypeScript strict + ESM, Node 20+.
- All 15 npm scripts exist and exit cleanly.
- `docker-compose.yml` for Postgres 16 and Redis 7 with healthchecks and
  named volumes.
- `src/infra/config.ts` — Zod-validated environment; the process exits on a
  missing or malformed variable.
- pino structured JSON logging with a per-request id.
- `GET /health` — real `SELECT 1` + real `PING`, `{ status, db, redis,
  uptime }`, 503 when a dependency is down, process stays alive.
- Two processes: `src/index.ts` (web) and `src/worker.ts` (worker
  heartbeat).
- `.gitignore`, `.env.example` (placeholders only), `.gitattributes`
  (`eol=lf`), `requests/health.http`.
- Docs: `docs/STACK.md`, `docs/DEPLOYMENT.md`, `docs/UI.md`,
  `docs/CODEMAP.md`, plus this file and `DECISIONS.log`.

Not started: everything else — schema, auth, intake, dispatch, the engine,
the commit path, the evaluation harness, the frontend, the LLM, payments,
deployment.
