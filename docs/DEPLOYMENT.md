# Deployment

What is deployed, how, and what it deliberately leaves out. The one-time
switch from the full seed to the demo board is in
[LIVE-CUTOVER.md](LIVE-CUTOVER.md).

## Shape

One Railway project, one public origin, four services:

| service | built from | what it is |
| --- | --- | --- |
| `web` | `Dockerfile`, `ZIPPY_PROCESS=web` | migrates, builds the demo board, serves the API, the consoles and the WebSocket |
| `worker` | `Dockerfile`, `ZIPPY_PROCESS=worker` | waits for migrations, then runs the BullMQ queues, the health loop and the demo refresh |
| `Postgres` | Railway template | **PostgreSQL 16** — the source of truth (invariant 1) |
| `Redis` | Railway template | **Redis 7** — cache and queues only |

`web` and `worker` are ONE image started two ways (`scripts/start-process.sh`),
so the two can never run different versions of the engine against one
database. Only `web` has a public domain.

**A push to `master` deploys both**, through a GitHub deployment trigger on
each service. Those triggers did not exist at first: the services were created
from the CLI before Railway's GitHub app had been granted the private repo, so
pushes silently deployed nothing until the triggers were added on 2026-10-17.
If a push ever fails to produce a deploy, check
`railway api 'query{project(id:"<id>"){deploymentTriggers{edges{node{branch serviceId}}}}}'`.

### Versions are pinned to what the tests run against

PostgreSQL **16** and Redis **7**: `docker-compose.yml` (`postgres:16`,
`redis:7`) and the testcontainers suite use exactly these, and so must the
deployment. Railway's templates default to newer majors — the first deploy of
this project came up on Postgres 18 and Redis 8.2. A major version cannot be
changed in place (a data directory written by 18 will not start under 16), so
the fix is a fresh service on the right image, done during the cutover:
see the appendix of [LIVE-CUTOVER.md](LIVE-CUTOVER.md) (written, not yet rehearsed).

| service | image to use |
| --- | --- |
| Postgres | `ghcr.io/railwayapp-templates/postgres-ssl:16` |
| Redis | `redis:7` |

### No routing service

Production runs with **haversine routing** (`ROUTING_MODE` unset means
`HAVERSINE` when `NODE_ENV=production`; see `chooseRoutingMode` in
`src/infra/config.ts`). The OSRM service was dropped: one fewer always-on
container, and the Delhi graph was the largest image in the deployment.
Haversine is local and deterministic, so invariant 10 holds; what is lost is
road shape — one-way streets and dividers are invisible to a straight line.
`GET /health` reports `routing.mode`, and every estimate stays flagged
degraded. Development and the test suites keep OSRM (`docker compose up`).

## Variables

Set on BOTH `web` and `worker` unless noted. Secrets are platform variables,
never committed and never baked into an image (`.dockerignore` drops `.env`).

| variable | value |
| --- | --- |
| `NODE_ENV` | `production` |
| `ZIPPY_PROCESS` | `web` on web, `worker` on worker |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (private network) |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` (private network) |
| `PUBLIC_URL`, `WS_ORIGIN`, `CORS_ORIGINS` | `https://${{web.RAILWAY_PUBLIC_DOMAIN}}` |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | two different random 32+ character strings |
| `SEED_PASSWORD` | every seeded login's password. Required in production; there is no fallback |
| `DEMO_MODE` | `true` for the demo board (below) |

`PORT` is injected by Railway. `OSRM_URL` is no longer read in production.
The LLM and Razorpay keys are optional; without them intake uses the symptom
picker and payments use the stub provider, and dispatch is unaffected.

## The demo board (`DEMO_MODE=true`)

Turned on with the steps in [LIVE-CUTOVER.md](LIVE-CUTOVER.md). **Nothing is
wiped**: the full seed stays in the database and demo mode hides it.

- **On every `web` boot**, after `prisma migrate deploy` and before serving,
  `prisma/seed/demoMinimal.ts` runs `ensureDemoBoard`: the demo zone, a
  dispatcher, a driver with a car, four crews (`src/demo/demoCrews.ts` — B can
  do everything and carries every part; A, C and D each lose for a reason the
  candidate table shows; only B can sign in), one 24x7 workshop, and once, a
  finished reference job run through the real dispatch path
  (`prisma/seed/demoReferenceJob.ts`). Idempotent. If it fails, the boot fails.
- **Hidden by filter, not deleted** (`src/demo/demoScope.ts`): the solver's
  snapshot and every dispatcher list see only the demo board — demo-tenant live
  jobs plus the reference job, the four crews, no depots, the demo workshop.
  With the flag off each filter is `{}`.
- **Two moments that had no trigger get one** (`src/demo/demoDispatch.ts`): a
  job whose intake finishes is re-planned so a dispatch card appears; a
  declined or timed-out offer is re-planned without whoever refused.
- **On `worker` boot and every 15 minutes** (`src/workers/demoRefresh.ts`): free
  any demo van left stuck (`src/demo/freeDemoVans.ts`), retire demo jobs left
  unassigned for over an hour, re-open shifts, re-count stock. A van on a
  running job is never touched (invariant 7). A completed job's van is also
  freed immediately, because completion alone never frees a van (see Not built).
- **Sign-in** (`GET /login/accounts`): only the three demo accounts are offered.
- `npx tsx scripts/demo-dry-check.ts` runs the engine for every fault type and,
  in demo mode, every fault through the real routes to crew B's screen. Exits
  non-zero on any failure; the tow is reported as a known limitation.

**The assistant's spending ceiling** applies in production whatever the demo
flag: `AI_HOURLY_LIMIT_PER_IP` (20) and `AI_DAILY_CALL_CAP` (300) on web, counted
in Redis (`src/ai/usageLimits.ts`). Past either, the driver gets the question
picker and a one-line reason.

## Failure and restart

- **Migrations run in one place**, the `web` boot. The `worker` waits for every
  migration its image ships before its first query
  (`src/infra/waitForMigrations.ts`), up to five minutes, then exits non-zero.
- **Restart on failure**: `web` and `worker` run Railway's `ON_FAILURE` restart
  policy with 10 retries — its default, confirmed on the live services through
  the API. It is a dashboard setting, not a file: a `railway.json` pinning it
  was tried and dropped, because Railway deprecated config-as-code and stops
  reading those files on 2026-12-01. If the setting should live in the repo,
  Railway's replacement is `.railway/railway.ts` (`railway config migrate`).
- **Health**: `GET /health` is 200 only when Postgres and Redis answer, 503
  otherwise, and carries the ladder and the routing mode.
- **The chaos panel does not exist in production** — `/chaos` routes are not
  mounted, so they are 404 (`tests/productionRoutes.test.ts`).

## Rules this deployment keeps

- **No free tier that sleeps.** The queues, the health loop and the WebSocket
  connections must stay up; a platform that spins the process down produces an
  empty board, which is the one thing a visitor must never open the link to.
- **No separate frontend host.** Express serves `/public` from the same origin,
  because the WebSocket the board depends on cannot live on a static host.

## Not built

Written down earlier as intentions; none of these exist yet. Do not describe
them as features.

- A simulator running continuously on the deployed instance.
- A scheduled board reset every four hours, announced in the UI.
- A per-IP rate limit on intake, and a daily LLM token budget that trips
  DEGRADED mode.
- Backups. The Railway trial's Postgres has none configured.
- **A completed job never frees its van.** Product-wide: the only code that
  sets a unit AVAILABLE is releasing a crew during a reassignment. Demo mode
  works around it for the demo vans; on the main seed every van stays ON_JOB
  after its first job.
- **Tows cannot be dispatched**: no workshop counterparty can confirm the
  destination (INTERVIEW.md 15.44).
- **No job cancellation route**, and no price range shown to the driver before
  the technician's estimate.
