# Live cutover — from the full seed to the demo board

A ONE-TIME procedure, run by a person, that switches the Railway deployment
from the full 24-unit seed to the self-maintaining demo board (`DEMO_MODE`,
see [DEPLOYMENT.md](DEPLOYMENT.md)). After it, no seeding is ever done by hand
again.

**Steps 3 and 4 destroy data and cannot be undone.** The Railway trial's
Postgres has no backups. Read every step before running the first.

Rehearsed end to end on a local copy before this file was written: a database
built by the full main seed, plus a job carrying an append-only event, was
wiped with step 3's file; every application table came back empty while
`_prisma_migrations` and the append-only triggers survived; `ensureDemoBoard`
then built the board and the dry check passed with crew B. The same was then
replayed INSIDE the production image (`docker build .`): step 3's exact
command, a web boot with `DEMO_MODE=true` (`/health` came up `NORMAL`,
routing `HAVERSINE`), and step 6's dry check run in the container. Step 2's
count command was run read-only against live `web` (41 users, 24 units, no
jobs at the time of writing). Step 4's SSH route
to Redis was checked on the live service with `PING` only. The commands as
written below have NOT been run against the live project — that is your call.

All commands run from the repository root on a machine where the Railway CLI is
logged in (`railway whoami`) and linked to the project (`railway link`, pick
`zippy`).

---

## 0 — Check before you start (changes nothing)

**The deployed build must already contain the demo-board code.** Every push to
`master` deploys `web` and `worker`, so this means the commits through
"docs: the live cutover runbook" are pushed and deployed. The tell is the
routing field in `/health`, which older builds do not have:

```bash
curl -s https://web-production-bd67f3.up.railway.app/health
# must contain:  "routing":{"mode":"HAVERSINE", ...
```

If it is missing, stop: push, wait for both deploys to finish, check again.

**You need an SSH key Railway knows about**, because steps 2-4 run inside the
containers. Once per machine:

```bash
ssh-keygen -t ed25519          # skip if ~/.ssh/id_ed25519 already exists
railway ssh keys add
```

---

## 1 — Set the variables, without deploying (deletes nothing)

```bash
railway variable set DEMO_MODE=true -s web    --skip-deploys
railway variable set DEMO_MODE=true -s worker --skip-deploys
```

`--skip-deploys` matters: a deploy now would build the demo board ON TOP of
the full seed, and the 24 seeded vans would compete with the four demo crews.

`SEED_PASSWORD` is already set on both services from the first deploy. Confirm
it is there without printing it (each line should print `1`):

```bash
railway variable list -s web    --kv | grep -c '^SEED_PASSWORD='
railway variable list -s worker --kv | grep -c '^SEED_PASSWORD='
```

To choose a new one instead, type it at the hidden prompt — it never appears on
screen or in shell history:

```bash
read -rs -p 'new SEED_PASSWORD: ' P && echo
printf '%s' "$P" | railway variable set SEED_PASSWORD --stdin -s web    --skip-deploys
printf '%s' "$P" | railway variable set SEED_PASSWORD --stdin -s worker --skip-deploys
unset P
```

It must be set: in production the boot-time seed refuses to run without it, and
the web deploy fails rather than falling back to the published dev password.

---

## 2 — Look at what is about to go (read-only)

```bash
railway ssh -s web -- node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();Promise.all([p.user.count(),p.unit.count(),p.job.count(),p.jobEvent.count()]).then(([u,n,j,e])=>{console.log({users:u,units:n,jobs:j,jobEvents:e});process.exit(0)})"
```

Expect roughly 41 users and 24 units from the full seed, plus whatever jobs the
site has collected. This is the last time those rows exist.

---

## 3 — Wipe Postgres (DESTROYS DATA)

```bash
railway ssh -s web -- npx prisma db execute --schema prisma/schema.prisma --file prisma/cutover/wipe-all-data.sql
```

Expect: `Script executed successfully.`

**What this deletes:** every row of every table in the `public` schema except
`_prisma_migrations`. That is every user and login (all the main seed's
accounts stop working), the whole fleet, technicians, shifts, workshops,
depots, every job and its event history, holds, offers, decision records,
payments, the ledger, stock, and the lookup tables. One `TRUNCATE` statement,
so it empties all of them or none.

**What it keeps:** the schema, indexes, triggers, and `_prisma_migrations`, so
the next boot's `prisma migrate deploy` correctly does nothing.

It gets past the append-only tables (`job_events`, `ledger_entries`,
`stock_movements`, `stock_confirmations`) because their guards are row-level
`DELETE` triggers and `TRUNCATE` fires none. The file explains this at the top:
`prisma/cutover/wipe-all-data.sql`.

The worker is still running against the now-empty database until step 5. That
is harmless — its health loop writes fresh rows and its queued jobs find
nothing to do — and step 4 clears its queues anyway.

---

## 4 — Flush Redis (DESTROYS QUEUED WORK)

```bash
railway ssh -s Redis -- sh -c 'redis-cli -a "$REDIS_PASSWORD" --no-auth-warning FLUSHALL'
```

Expect: `OK`

**What this deletes:** every key in Redis — every queued, delayed and failed
BullMQ job (solves, offer expiries, notifications for jobs that no longer
exist), the repeat schedulers for the cleanup sweep and the payout run, and
Socket.IO's adapter state. Redis is cache and queues only (invariant 1), so
nothing here is a record of anything; leaving it would mean the worker
processing jobs that point at deleted rows. The worker re-creates its
schedulers, including the demo refresh, when it boots in step 5.

---

## 5 — Redeploy, web first (deletes nothing)

```bash
railway deployment redeploy -s web -y
```

Wait until it reports success (`railway deployment list -s web` shows
`SUCCESS`, or watch the dashboard). On this boot the web service runs
`prisma migrate deploy` (nothing to apply) and then **`ensureDemoBoard`**,
which re-creates the lookup tables and builds the demo board before it starts
serving. Its log ends the seed with:

```
demo board ready: 1 zone, 1 dispatcher, 1 driver, 4 of 4 crews refreshed
```

Then the worker:

```bash
railway deployment redeploy -s worker -y
```

It waits for migrations, runs the demo refresh once, registers the
fifteen-minute schedule, and starts its queues. Its log contains
`demo refresh: 4 shifts reopened, 4 vans re-counted`.

**Stop here if either deploy fails.** The web deploy fails on purpose if the
board cannot be built — most often a missing `SEED_PASSWORD`. Read its log.

---

## 6 — Check the result (read-only)

```bash
railway ssh -s web -- npx tsx scripts/demo-dry-check.ts
```

Must end in `PASS — crew B wins` and exit 0. Then:

```bash
curl -s https://web-production-bd67f3.up.railway.app/health
```

Expect `"status":"ok"`, `"mode":"NORMAL"`, no degraded components (the old
`Crew on shift` banner is gone), and `"routing":{"mode":"HAVERSINE"`.

Finally sign in at `/dispatcher` as `demo-dispatcher@zippy.internal` with
`SEED_PASSWORD`: the board is empty and there is no red banner. DEMO.md takes
it from there.

---

## If you need the full seed back

There is no undo for steps 3-4. To rebuild the full 24-unit board instead,
unset `DEMO_MODE` on both services, wipe again with step 3, and run the main
seed inside the container: `railway ssh -s web -- npm run db:seed`. Its shifts
are clock times, so that board lapses into `Crew on shift` degraded again
within a day — the reason the demo board exists.

---

## Appendix — Postgres 16 and Redis 7 (optional, NOT tested)

The live services came up on Railway's template defaults, **Postgres 18** and
**Redis 8.2**; the stack, `docker-compose.yml` and the test suites are on
**16** and **7** (DEPLOYMENT.md). Nothing has failed because of it, but it is a
gap between what is tested and what runs.

A major version cannot be changed in place — a data directory written by 18
will not start under 16 — so the change is a NEW service, and the cutover, when
the data is being thrown away anyway, is the cheapest moment to make it. In
outline, in the Railway dashboard, between steps 2 and 5:

1. Delete the `Postgres` service **and its volume** (this replaces step 3).
2. Add a new database from the PostgreSQL template, name it exactly `Postgres`
   so `${{Postgres.DATABASE_URL}}` on web and worker resolves to it, and set its
   source image to `ghcr.io/railwayapp-templates/postgres-ssl:16` before it
   first starts. If it already started on 18, delete its volume and redeploy
   it.
3. The same for Redis with `redis:7` (this replaces step 4), keeping the name
   `Redis`.
4. Continue at step 5. The web boot's `prisma migrate deploy` now applies all
   17 migrations to the empty database before `ensureDemoBoard` runs.

This path has not been rehearsed. The template's exact behaviour when its image
is changed is the uncertain part; check `railway variable list -s Postgres` has
a `DATABASE_URL` before redeploying web.
