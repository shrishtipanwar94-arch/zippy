# Stack

Every choice here is locked. Each entry names the alternative that was
rejected and gives a one-sentence defence. The point of writing it down is so
these do not get relitigated mid-build.

## Locked choices

### PostgreSQL — not MongoDB
Zippy needs version-checked conditional updates (optimistic locking on units
and jobs), transactional saga legs, an append-only ordered event log, and a
relational domain with real foreign keys. Postgres gives all of that in the
box; Mongo needs a replica set before it will do a multi-document
transaction.

### Prisma — not a query builder or raw pg
Typed schema, typed migrations, one generated client. Hand-written SQL is
still used where it must be (the version-checked `UPDATE ... WHERE version = $n`
in /src/commit), with parameter binding, never string interpolation.

### Modular monolith — not microservices
/src/engine has no database or Redis imports, so allocation is a pure
function over a snapshot: testable without infrastructure and importable by
the evaluation harness unchanged. Splitting into services would buy nothing
here except a network hop inside a dispatch decision, which invariant 10
forbids.

### Two processes from day one — web and worker
`src/index.ts` and `src/worker.ts` are separate processes, not one process
with a background timer. They deploy separately and fail differently: the web
process can be down while the worker drains a queue, and vice versa. Building
this now costs nothing; retrofitting it later means untangling shared state.

### No frontend build step — not React/Vite
The value of this project is the backend. The discipline React would enforce
is enforced by hand instead: one client-side state object, one
`render(state)` per panel, nothing else touches the DOM. Bootstrap, Leaflet
and morphdom load from a CDN. No bundler, ever.

### Optimistic locking — not pessimistic (SELECT ... FOR UPDATE)
Contention is low (a given unit is rarely fought over) and a pessimistic lock
would be held open across an external actor's response time — a technician
taking twenty seconds to answer their phone would hold a row lock for twenty
seconds. A conditional update on a `version` column detects the race without
holding anything.

### Self-hosted OSRM — not Google Maps / Mapbox (from Phase 6)
Invariant 10. An external routing call makes seeded replay non-reproducible:
two runs of `npm run eval` with the same seed would get different travel
times, which destroys the one claim the project rests on. OSRM is local,
free, needs no key, and returns identical answers every time. It also makes
carriageway direction real — a unit on the far side of a divided highway is
20 km away by road while 200 m away in a straight line.

### Redis for cache and queues only — never for holds
Invariant 1. A reservation in Redis can be lost on eviction or a restart.
Holds live in Postgres as rows with a version and a TTL.

### BullMQ — not Kafka
The workload is delayed jobs, retries with backoff, a dead-letter queue and a
debounce. BullMQ on the Redis that already exists covers all of it. Kafka is
a log, not a job queue, and would be infrastructure with no consumer.

## Do not relitigate

- Postgres → MongoDB
- Express → Nest
- vanilla JS → React (or any frontend framework / build step)
- modular monolith → microservices
- holds or reservations in Redis
- Kafka
- Supabase / a hosted BaaS
- a second host just for the frontend
- a hosted maps or routing API anywhere near a dispatch decision
