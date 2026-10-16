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

- **On every `web` boot**, after `prisma migrate deploy` and before serving,
  `prisma/seed/demoMinimal.ts` runs `ensureDemoBoard`: one zone, one
  dispatcher, one driver with a car, four crews (`src/demo/demoCrews.ts`).
  Idempotent, so it is safe on every boot. If it fails, the boot fails and the
  deploy shows as failed rather than serving an empty board.
- **On `worker` boot and every 15 minutes**, `refreshDemoShifts` and
  `refreshDemoStock` keep the crews on shift and their stock counted
  (`src/workers/demoRefresh.ts`). Without this the board stops working within
  eight hours: shifts end, and a stock count that old reads UNVERIFIED.
- **A van on a live job is never touched** by either (invariant 7).
- `npx tsx scripts/demo-dry-check.ts` checks the board makes the choice it was
  built for, and exits non-zero if not.

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
