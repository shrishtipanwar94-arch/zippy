# INTERVIEW.md

A living interview-prep document for the maintainer. It is maintained
automatically: one structured entry per phase goes into DECISIONS.log, and at
checkpoints (end of Phases 4, 9, 13, 17, 22) that log is consolidated in here
and cleared.

**State after Phase 9 (checkpoint).** The thesis is now implemented. A job goes
from a symptom payload to three ranked, globally-assigned plans through a pure
engine — candidates, feasibility filters with reason codes, a five-term cost
function over expected time-to-resolution, and a hand-written Hungarian
assignment. What does not exist yet is any way to ACT on a plan: no holds, no
offers, no saga. Sections below say so where that is the honest answer.

---

## 1. Project Overview

Zippy is a roadside breakdown dispatch system. The thesis: optimise expected
**time-to-resolution**, not time-to-arrival. The nearest technician often
cannot fix the fault — dispatching them is fast to arrive and slow to resolve,
because a second dispatch then has to happen. Zippy computes the expected time
for the fault to actually be fixed, including the cost of a likely re-dispatch,
and allocates against that.

**That objective function now exists and produces the claimed behaviour.**
Measured on the seeded fleet: a 2km unit that can only jump-start scores 48.5
minutes expected resolution against 44.0 for a 7km unit that can handle both
contending faults. The far unit arrives later and finishes sooner, and the
system picks it.

Assignment is **global**, not per-job: `src/engine/allocation.ts` solves the
whole pending board as one assignment problem, so a job whose only possible
unit would have been taken by an earlier, marginally-better match is not
stranded.

## 2. Architecture

- **Modular monolith**, two processes: `web` (`src/index.ts`) and `worker`
  (`src/worker.ts`). The worker runs four BullMQ queues (`solver`,
  `offer-expiry`, `notification`, `cleanup`) plus a repeatable cleanup sweep.
- **Express** app built in `src/api/app.ts`, started in `src/index.ts`, so
  routes are testable without binding a port. Socket.IO shares the same HTTP
  server: one origin, one certificate, nothing extra to expose.
- **Postgres via Prisma is the source of truth** (invariant 1). Redis carries
  queues, BullMQ's idempotency/dedup state, and the Socket.IO adapter's
  pub/sub — never a hold or a reservation.
- **Self-hosted OSRM** on `localhost:5001`, built from a Bengaluru bounding-box
  extract, with a haversine fallback. Invariant 10 says no external API sits in
  a decision path; a local, versioned map extract is what makes the routing
  input to a decision reproducible.
- Layers, in dependency order:
  - `src/domain/` — pure. Fault rules, entropy, safety, location, geo. No
    Prisma, no clock, no `Math.random`.
  - `src/engine/` — the solver. Candidates, feasibility, durations, cost,
    ranking, allocation, solve. **Zero imports from prisma or redis**, checked
    by a standing grep, and it writes nothing.
  - `src/intake/` — the domain applied to the database in transactions.
  - `src/commit/` — mutation, and reads that touch the database on the engine's
    behalf: `dispatchSnapshot.ts`, `persistSolverRun.ts`.
  - `src/queues/` — connections, names, backoff, idempotency, debounce,
    dead-letter, Bull Board.
  - `src/workers/` — one processor per queue.
  - `src/realtime/` — Socket.IO, rooms, the fan-out point, the outbox, the
    Redis adapter.
  - `src/sim/` — the simulator, a production component, not a dev tool.
- **Three separate Redis connection families**, because their requirements are
  mutually incompatible: health checks must fail fast
  (`maxRetriesPerRequest: 1`), BullMQ's blocking fetch *requires*
  `maxRetriesPerRequest: null`, and a pub/sub connection is locked into
  subscriber mode the moment it subscribes.
- **No frontend build step.** `/public` is plain ES modules served statically.

## 3. Request Lifecycles

**Intake** (`POST /jobs/intake` → `src/intake/createJob.ts`) is complete. In a
single transaction it creates the `jobs` row, writes a `symptom_reports` row
and a `location_events` row, computes a fault distribution and stores it as
`fault_hypotheses`, triages safety onto `Job.safetyLevel`, and appends five or
six `job_events`.

**Questioning** (`GET /jobs/:id/next-question`, `POST /jobs/:id/answers`) loops
until one of four stop conditions. Each answer writes an `intake_answers` row
carrying entropy before, entropy after and expected gain.

**Solve** (`POST /solve` → `src/api/solve.ts`) is the new one, and it is the
project's centre:

1. `buildDispatchSnapshot(prismaBase)` reads pending jobs, units, technicians,
   shifts and zones into plain objects.
2. `solve()` generates candidates per job (`generateCandidates`, which batches
   an OSRM many-to-one table call), filters them (`checkFeasibility`, ten
   reason codes), scores every survivor under all three weight vectors
   (`scoreOption`), and runs `solveAssignment` once per vector.
3. `persistSolverRun()` writes one `solver_runs` row, one `dispatch_options`
   row per rejected option (with its reason code) and per chosen assignment
   (with its cost breakdown), and three `plan_variants`.
4. The route returns the three plans. Nothing is reserved.

Offer, en-route, completion and payment lifecycles: **not implemented**. There
is no path from a plan to an assignment — that is Phases 11–12.

## 4. Database

83 tables from Phase 1, most still unread — deliberately, so migrations only
ever grow. Actually exercised after Phase 9: `tenants`, `users`,
`tenant_memberships`, `drivers`, `vehicles`, `vehicle_profiles`, `zones`,
`capabilities`, `technicians`, `technician_capability`, `technician_shifts`,
`units`, `unit_capability`, `unit_stock`, `jobs`, `job_events`,
`symptom_reports`, `fault_hypotheses`, `intake_questions`, `intake_answers`,
`location_events`, `audit_logs`, `job_processing_log`, `solver_runs`,
`dispatch_options`, `plan_variants`.

Three patterns carry the design:

- **Append-only log.** `job_events` and `ledger_entries` reject UPDATE and
  DELETE via a database trigger, not just a permission — a superuser bypasses
  table privileges but not a BEFORE-ROW trigger that raises. Consequence,
  discovered the hard way: **a job that has events cannot be deleted at all**,
  by anyone.
- **Optimistic version column** on every row two actors can race (`units`,
  `jobs`, `unit_holds`, `dispatch_offers`, …). Currently used by
  `releaseExpiredHolds` in `src/workers/cleanup.ts`; its first heavy use is
  Phase 11.
- **Unique constraint as the idempotency mechanism.**
  `job_processing_log(queue, idempotency_key)` is what "every processor is
  idempotent" actually rests on — not an in-memory set, which is erased by
  exactly the crash that would need it.

Money is integer paise. Anything originating outside Zippy records both
`event_time` and `received_at`.

## 5. API Design

```
POST /auth/login              email + password -> access + refresh
POST /auth/refresh            refresh -> a fresh pair
GET  /health                  real SELECT 1 + real PING, 503 when a dep is down
GET  /jobs                    scoped + ownership-narrowed list
GET  /jobs/:id                404, never 403, when not visible
POST /jobs/intake             symptom payload -> job + hypothesis + next question
GET  /jobs/:id/next-question  the entropy selector's decision
POST /jobs/:id/answers        record one answer, get the next step
POST /solve                   plan every pending job -> three plans, DISPATCHER only
GET  /admin/queues            Bull Board, DISPATCHER only
```

`GET /units` and `PATCH /jobs/:id/assign` were **deleted at Phase 9**, along
with `src/commit/assignUnit.ts`, the `jobAssignment` permission, and the
dispatcher's per-row unit dropdown. The board now shows three plans instead.

Conventions held: typed errors mapped to status codes in one place per module,
a `JobEvent` on every state transition, 404-not-403 for rows a caller may not
see, strict Zod schemas so an unknown key is a 400 rather than a silent strip.

Convention **not** held: idempotency keys. `CLAUDE.md` says every
external-facing mutation takes one; none do, and `idempotency_keys` is written
by nothing (the cleanup sweep that expires them runs against an empty table).

## 6. Auth

JWT access + refresh with separate secrets, argon2id hashing, and **three
layers of read authorisation**, each in its own file and none in a route
handler:

1. **RBAC** — `src/auth/permissions.ts`, a role → resource → action table
   behind one `can()`. `solverRun` and `queueAdmin` are their own resources
   precisely because a TECHNICIAN has `update` on `job` for their own work and
   that must not extend to running the solver or reaching the queue dashboard.
2. **Tenant scoping** — `src/infra/tenantScopeExtension.ts` injects a
   `tenantId` filter into every query on a tenant-scoped model. A query that
   loses its scope filters by `NO_TENANT`, an id that cannot exist, and returns
   nothing. A DISPATCHER reads across tenants and every such read writes an
   `audit_logs` row.
3. **Row ownership** — `src/infra/jobOwnershipExtension.ts` narrows a DRIVER to
   `driverId = theirs` and a TECHNICIAN to `assignedTechnicianId = theirs`, on
   top of the tenant filter, never instead of it.

The socket handshake uses the same `verifyAccessToken`, and `job:subscribe`
authorises through the same scoped client.

`POST /solve` is the deliberate exception: it reads on the **unscoped** client,
because a fleet-wide plan that quietly ignored units the dispatcher commands
would be worse than no plan. The role check is the only thing protecting it.

## 7. Backend Concepts Used

Only what the code actually exercises:

1. **Shannon entropy and Bayesian updating** — `src/domain/entropy.ts`.
2. **Expected information gain** — `src/domain/questionSelection.ts`.
3. **Naive Bayes** — `src/domain/faultRules.ts`, used in both directions: the
   classifier inverts it, the simulator generates from it.
4. **Expected value over a distribution as a decision input** —
   `src/engine/cost.ts`. The fault distribution is consumed as a weighting over
   outcomes, not collapsed to its mode. A pair that cannot resolve a fault
   carries that fault's probability × the cost of a second dispatch.
5. **Hard constraints as filters, never penalties** — `src/engine/feasibility.ts`
   returns `{ option, code, detail }`, and infeasible options are *removed*.
   Invariant 3's argument: a penalty large enough to act like a constraint is a
   constraint with a latent bug, because enough other terms eventually outvote
   it.
6. **Lexicographic ordering above the cost function** — `src/engine/ranking.ts`.
   A HIGH_RISK job orders by arrival first and only breaks ties on cost.
   Deliberately kept in its own file so it cannot drift into being a sixth
   weighted term.
7. **The assignment problem, and the Hungarian algorithm** —
   `src/engine/allocation.ts`, written by hand. Row and column potentials,
   reduced cost `cost - rowPotential - colPotential` kept non-negative,
   augmenting paths through zero-reduced-cost cells, potentials shifted by the
   smallest slack when the search runs out of edges. LP duality is why a
   matching over zero-reduced-cost cells is provably optimal.
8. **Brute-force differential testing** — 300 seeded random matrices, every
   permutation enumerated, compared to the algorithm's answer. "It returned an
   assignment" proves nothing about an optimisation algorithm.
9. **Content-addressed snapshot hashing** — `hashSnapshot` fingerprints exactly
   the inputs that can change a decision (including zone centroids, because a
   unit with no GPS is located at one), so a stored `SolverRun` is replayable.
10. **At-least-once delivery vs exactly-once effects** — `runIdempotently`
    inserts the `job_processing_log` row and runs the effect in the *same*
    Postgres transaction, so a failed effect and a logged "done" cannot
    disagree.
11. **Job deduplication as a debounce** — BullMQ's `deduplication` + `delay`,
    verified empirically rather than assumed: the FIRST call in a window wins.
12. **Capped exponential backoff and a real dead-letter queue** — the cap
    matters because an uncapped retry and a hung job look identical from
    outside; the DLQ matters because BullMQ has no cross-queue concept of one.
13. **Pub/sub fan-out across OS processes** — `@socket.io/redis-adapter` in the
    web process, `@socket.io/redis-emitter` in processes with no `Server`.
14. **Optimistic locking** — conditional `UPDATE … WHERE id = ? AND version = ?
    AND status = ?`, so the check and the claim are one statement.
15. **Transactional outbox** — events buffered during a transaction, published
    only after commit.
16. **Real road-network routing as a reproducibility technique** — OSRM's MLD
    pipeline (`osrm-partition` + `osrm-customize`, not contraction hierarchies),
    many-to-one matrix batching, per-origin haversine fallback.
17. **Seeded PRNG as a correctness requirement**, AsyncLocalStorage for
    request-scoped context, Prisma extensions as an enforcement point,
    fail-fast config, graceful shutdown extended to "let the in-flight job
    finish or requeue".

## 8. Engineering Problems

**Solved and measurable:**

- *How many questions should intake ask?* Entropy decides; the count varies
  with ambiguity. Measured: `FLAT_TYRE` 0.00 questions, `WONT_START` 3.17.
- *Why send the further unit?* Because expected time-to-resolution sums over
  the whole fault distribution. Measured: 48.5 min (2km, narrow) vs 44.0 min
  (7km, broad).
- *How do you avoid stranding a scarce-capability job?* Global assignment. A
  test constructs the case where the only EV-certified unit sits next to a
  battery job; nearest takes it, the Hungarian assignment gives the battery job
  the further unit it can still use, and both jobs get served.
- *How do you publish an event exactly when it is real?* The outbox.
- *How do you make a queue processor idempotent?* A unique constraint, with the
  effect inside the same transaction.

**Ahead, and the interesting ones:** the evaluation harness that imports the
production engine (Phase 10), version-checked holds under real concurrency
(11), the reservation saga and its compensations (12), re-dispatch (13).

## 9. Concurrency

- **Two writers appending a job event to the same job.** Both read
  `MAX(sequence)` and compute the same next value; the `(job_id, sequence)`
  unique index rejects the loser. Handled by retrying the **whole
  transaction** (`src/intake/transaction.ts`), not the statement — Postgres
  marks a transaction aborted on any error, so nothing can be retried inside
  it. Assumption: contention on one job is rare, so three attempts suffice.

- **The same intake answer submitted twice.** Both transactions load the
  session, both see the same pending question, both pass the guard. One loses
  the event-sequence constraint, rolls back, re-reads and is then rejected with
  `QUESTION_NOT_PENDING`. **This protection is incidental** — it falls out of
  the event write rather than from anything that declares the intent.

- **Two deliveries of the same queue idempotency key overlap** — a genuine
  concurrent enqueue, or a retry racing a crash-redelivery. Both transactions
  attempt the same `(queue, idempotency_key)` INSERT; the unique constraint
  rejects the loser and its *whole* transaction, effect included, rolls back.
  Proved with a real `Promise.all` of two concurrent calls sharing one key in
  `tests/queues.test.ts`, against real Postgres, with a counter showing the
  effect ran exactly once. Assumption relied on: the effect is itself a
  Postgres write, so it can share a transaction with the log insert. A
  processor whose real effect is external (an SMS, an HTTP call) cannot use
  this pattern and needs a two-phase version — Phase 15b.

- **A worker is killed holding a job's lock.** BullMQ's stalled-job checker
  reclaims and redelivers it; redelivery is indistinguishable from a retry to
  `runIdempotently`. Assumption: BullMQ's default 30s `lockDuration` —
  untuned, untested.

- **The cleanup sweep releases an expired hold at the moment something else
  resolves it.** Conditional `updateMany` on
  `status = 'ACTIVE' AND expiresAt < now()`; a hold no longer `ACTIVE` no
  longer matches. **This race is real in shape but has never been exercised** —
  nothing writes a hold until Phase 11.

- **The world moves under a snapshot.** The solver reads a frozen picture and
  reasons about it; a unit can go `OFFLINE` a second later. Deliberately not
  handled here — a plan is a recommendation and nothing is reserved. Validating
  a stale decision at commit time is what Phase 11's version-checked hold is
  for, and writing a weaker version of that check in the solver would mean
  writing it twice.

**Regression to state plainly:** deleting `tests/assign.test.ts` at Phase 9
removed the two-dispatchers-one-unit race test along with the code it tested.
The conditional-update pattern is still exercised by the queues test, but the
specific unit-claim race has no test again until Phase 11.

The testcontainers-backed suite (`npm run test:concurrency`) is **still
empty**; the real-Postgres tests that exist share the `zippy_test` database.

## 10. Failure Handling

- The process survives a dependency outage; `/health` degrades to 503.
- **OSRM down is a degraded state, not an outage.** Every travel-time result
  carries `degraded: true` and `method: 'HAVERSINE_FALLBACK'` when OSRM did not
  answer, and that flag travels *with the option* to the dispatcher rather than
  living only in a log line (invariant 8). Verified by stopping the container
  mid-session and watching real routing resume after restarting it.
- **A partial OSRM batch degrades per-origin, not wholesale** — one unroutable
  unit falls back to haversine; the rest of the batch keeps its real answer.
- Retries: capped exponential backoff (base 1s, cap 5min, 5 attempts), with a
  real `dead-letter` queue populated only when `attemptsMade >= attempts`, so
  "will retry" and "will never retry" are not mixed in one view.
- `publishJobEvents` catches and logs its own failures: by the time it runs the
  transaction has committed, and a Redis hiccup must not turn "the job was
  created" into a 500.
- A rolled-back transaction publishes nothing.
- A reconnecting socket replays from its cursor; a client that missed more than
  500 events is told `truncated` rather than given a partial history.
- Delivery is **at-least-once by choice**: a duplicate is detectable, a gap is
  not. The client de-duplicates by sequence.

Compensations and saga recovery: **not implemented** (Phase 12).

## 11. Security

- Secrets in `.env` only; `.env.example` holds placeholders.
- Three-layer read authorisation (§6), enforced by Prisma extensions.
- Socket JWT verified **on the handshake**; the token travels in
  `handshake.auth`, not the URL.
- Strict Zod schemas: a caller cannot set a server-derived field.
- Body capped at 1 MB; CORS reflects only allowlisted origins.
- Bull Board is mounted per-route behind `authenticate` +
  `requirePermission('read', 'queueAdmin')`, not behind a pathless
  `.use(authenticate)`.

Not done: rate limiting, refresh-token revocation, idempotency keys, and any
audit trail for actions taken *through* Bull Board's UI (it can retry, discard
and promote jobs, none of which is separately RBAC-checked or logged).

## 12. Scaling

No load measurements, none claimed. Four structural limits worth knowing:

- **The assignment is O(n³) in the number of jobs**, which is why zone
  partitioning exists above `SOLVER_ZONE_PARTITION_THRESHOLD` candidate
  options. It is an approximation with a known, tested cost — see §15.
- **The solver re-queries OSRM on every run** with no cache. `POST /solve` over
  every pending job is O(jobs × units) routing work, batched many-to-one per
  job but shared between jobs not at all.
- **The realtime outbox is in-process**, but the Socket.IO Redis adapter now
  makes cross-process delivery work — an event written by the worker or the
  simulator reaches a browser on the web process. Verified by commenting out
  the single line that installs the adapter and watching the delivery test go
  from passing to a timeout.
- **Every processor's exactly-once guarantee is Postgres-bound.** It scales
  with Postgres, and it does not extend to an external effect at all.

## 13. Design Decisions & Tradeoffs

Carried from `docs/STACK.md`: Postgres over Mongo; modular monolith over
microservices; no frontend build step; two processes from day one; optimistic
over pessimistic locking; self-hosted OSRM over a hosted maps API; BullMQ over
Kafka.

**Phases 1–4 (intake and the skeleton):**

- **Expected information gain over a hand-built decision tree or an LLM.** It
  is the direct formalisation of "ask what tells you most", it is pure
  arithmetic, and question count falls out of ambiguity. An LLM would break
  invariant 5 (it would be deciding) and invariant 10 (an external call inside
  a decision). Tradeoff: question quality is capped by the likelihood table.
- **Capability-set stability as a stop condition.** Once every contending fault
  resolves to the same capability, more questions cannot change who gets sent.
  This is what makes it a dispatch system rather than a diagnosis quiz.
- **A fault a question does not model is UNIFORM over its answers.** A
  plausible-looking default row quietly promotes every fault the question
  forgot. That bug was in the file once and made a stuck vehicle look like a
  flat tyre.
- **Safety as a flat rule list producing reason codes, not a score**, because a
  score invites exactly the trade-off invariant 4 forbids.
- **Derived facts are not client inputs** (`onHighway`, `night`).
- **Unknown road position fails CLOSED**, matching `NO_TENANT`/`NO_OWNER`.
- **The simulator drives the real intake functions**, not a copy.
- **One fan-out point, publishing after commit.**
- **The reconnect cursor is per job**, because `job_events` has no global
  counter and `at` is not monotonic with insertion order.

**Phase 5 (queues):**

- **Exactly-once effects enforced by a real unique constraint, with the effect
  inside the same transaction as the log insert.** Alternative: check-then-act
  in application code. Why not: two concurrent deliveries can both pass the
  read before either writes — a TOCTOU race the constraint closes. Tradeoff:
  only correct for an effect that *is* a Postgres write.
- **Debounce built on BullMQ's first-class `deduplication` + `delay`**, not the
  "add with a fixed jobId and let duplicates silently no-op" trick — that works
  by side effect of a feature meant for something else.
- **Three Redis connection families, not one shared connection**, because any
  one setting is wrong for at least two of the three uses.
- **A real cross-queue dead-letter queue**, because an operator wants one place
  to see every terminal failure, not four failed sets. Tradeoff: the failure is
  visible twice, deliberately — the original stays as the detail, the DLQ is
  the triage list.
- **The heterogeneous processor table is typed as BullMQ's own `Processor`.** A
  `(job: never) => …` table is fine to *build* but cannot be *passed* to
  `new Worker()` — contravariance runs opposite directions for construction and
  consumption, and `tsc` caught it immediately.

**Phase 6 (candidates and routing):**

- **An Overpass bounding-box export over a Geofabrik country extract**, because
  Geofabrik has no Karnataka-level cut and every seeded zone is Bengaluru.
  Tradeoff: dependent on a shared public instance's rate limits, which is why
  the script takes an endpoint override.
- **`DispatchOption` carries `travelEstimateDegraded`** beyond the four fields
  the brief lists, because invariant 8 requires the degraded state to travel
  with the option a dispatcher looks at, not in a log line.
- **The OSRM base URL is an explicit parameter with a config default**, so a
  test can point one call at a dead address without mutating global state.
- **`coveredFaultProbability` sums over all twelve faults;
  `missingCapabilities` reuses the existing contending-fault set.** Two
  different questions: "what fraction of the belief can this pair resolve"
  (the whole distribution, so a generalist scores near 1.0 against real
  uncertainty) versus "what is this pair missing" (anchored to the requirement
  intake already settled on).
- **An uncrewed unit produces no option at all, not a rejected one.** A
  rejection is for a candidate that exists but should not be sent; nobody can
  crew a van with no driver.
- **`unitLocation` throws rather than defaulting to `0,0`.** Reaching that
  branch means the snapshot was assembled wrong; `0,0` would claim the unit is
  off the coast of Africa and produce a wrong-but-plausible travel time.

**Phase 7 (feasibility):**

- **Each rejected option carries exactly ONE code**, the first and most
  fundamental reason, in a fixed order. `{ option, code, detail }` is what the
  "Why this technician?" panel shows — one sentence, not a debugging dump.
  Tradeoff: the *order* is now a real design decision with real consequences.
- **`VEHICLE_TYPE_INCOMPATIBLE` is checked against the unit's KIND
  independently of capability codes.** Capability codes are per-row data
  nothing enforces against kind; a bike that somehow had `FLATBED_LOADING`
  attached still physically cannot carry a car. The overlap on well-formed data
  is the point, not a bug.
- **The "opposite carriageway" trigger is a travel-time-to-straight-line RATIO
  (4x), not a per-unit carriageway comparison**, because no schema field
  records which side of a divided highway a unit is on. A ratio built from data
  that exists is honest; inventing a heading field would be inventing data.
- **`NO_TECHNICIAN_ON_SHIFT` adds a flat 45-minute service estimate to travel
  time**, because "on shift long enough to travel there" is not the claim the
  code's name makes.

**Phase 8 (cost):**

- **The lexicographic comparator lives in `ranking.ts`, not `cost.ts`.** The
  phase's own check greps cost.ts for `safety` and requires no match — and the
  grep is correctly detecting a design fact. A comparator that wraps a ranking
  is not part of the thing being wrapped, and putting it in the cost file would
  leave it one refactor from becoming a sixth weighted term.
- **`escalationMinutes` is composed from three named parts and varies per
  fault**, because a mis-dispatch to a tyre change and to a high-voltage fault
  are not the same mistake. Tradeoff: the second unit's *travel* is one flat
  figure, because the second unit is by definition not chosen yet.
- **Every term keeps its natural unit** — minutes, km, probabilities, paise —
  and the weights carry the conversion. Normalising to [0,1] would need an
  invented scale per term, and a breakdown reading "44 minutes / 7 km" explains
  itself where "0.62 / 0.35" does not. Tradeoff: the weights look wildly
  inconsistent (1.0 next to 0.0004) until you know each term's magnitude.
- **`capabilityShortfallRisk` recomputes the shortfall rather than returning
  `1 - coveredFaultProbability`**, because that identity holds only while the
  distribution sums to 1, and drift should be visible rather than silently
  plausible.
- **`slaRisk` measures how much of the remaining window an arrival consumes**,
  not whether it breaches — feasibility already rejected every breach, so
  "would it breach" carries no information.

**Phase 9 (allocation):**

- **The matrix is jobs × UNITS, not jobs × options**, because the constraint
  the assignment problem exists to respect is invariant 7 — one active job per
  unit. Tradeoff: a job with two options on one unit collapses to the cheaper
  before the matrix is built, so the technician choice *within* a unit is
  greedy.
- **Infeasible and padding cells use a large FINITE sentinel**, because
  `Infinity - Infinity` is `NaN` and the potential arithmetic silently stops
  making sense. It is not a disguised constraint: feasibility already removed
  every rule-breaking option, so there is no rule left for a number to encode,
  and a row landing on such a cell is returned as *unassigned*, never as an
  assignment.
- **`hungarian` throws when `rows > cols`** instead of trusting its caller to
  have padded. With more rows than columns the augmenting search never reaches
  an unmatched column and the loop spins forever — and a hang is the worst
  available failure in a dispatch path.
- **All three plans come from ONE candidate-generation pass.** Calling
  `solve()` three times would triple the routing traffic and, worse, give the
  three plans three different snapshots — which destroys the only reason to
  show three.
- **Zone partitioning triggers on OPTION count, not job count, and the
  threshold is config.** Twenty jobs against two units is not the same problem
  as twenty against a hundred; and Phase 10 has to be able to move the
  threshold to measure what it costs.
- **The engine returns a `zonePartitioned` flag; the route logs it.** A logger
  inside a function the harness replays thousands of times would emit thousands
  of lines and give the engine an infrastructure dependency it has no other
  reason to have.

## 14. Interview Questions

Questions the code can answer today:

- *Why does "flat tyre" ask no questions and "my car will not start" ask about
  three?* Because the count is not scripted. A stated flat tyre lands at 0.518
  bits, under the 0.65-bit threshold, so `decideNextQuestion` returns STOP. A
  bare no-start lands at 2.618 bits, so the selector scores every unasked
  question by expected information gain until entropy drops, every contending
  fault needs the same capability, or the cap of 5 is hit. Measured:
  `FLAT_TYRE` 0.00 questions, `WONT_START` 3.17.

- *Why does a 7km unit beat a 2km one?* Because "nearest" answers the wrong
  question. With a genuinely uncertain diagnosis — half flat battery, half
  failed battery — the 2km unit can only jump-start, so half the probability
  mass ends in a second dispatch: coordination wait, a replacement unit's
  travel, then the repair. 48.5 minutes expected resolution for the near unit
  against 44.0 for the 7km one that handles both.

- *Why not just give each job its best option?* Because greedy strands jobs.
  The first job takes the only EV-certified unit because it is marginally
  better *there*, and the genuinely-EV job later in the list gets nothing.
  `tests/solve.test.ts` builds exactly that fleet: the Hungarian assignment
  gives the battery job its second choice so both jobs are served.

- *Why implement the Hungarian algorithm rather than importing one?* Because
  this is the decision a dispatcher is most likely to challenge — "why did the
  van two streets away go to the other job?" — and "the library said so" is not
  an answer. Each row and column carries a potential; the reduced cost of a
  cell is `cost - rowPotential - colPotential`; the algorithm keeps every
  reduced cost non-negative and matches only over zero-reduced-cost cells, and
  LP duality says such a matching is optimal. Checked against brute force on
  300 seeded matrices.

- *Your infeasible cells hold a huge number. Is that not a constraint expressed
  as a penalty — which your own invariant 3 forbids?* No. A disguised
  constraint is a penalty standing in for a rule that other terms can
  eventually outweigh. Feasibility ran first and removed every rule-breaking
  option, so there is no rule left for the number to encode.
  `UNAVAILABLE_COST` means "there is nothing here to choose", and
  `solveAssignment` translates a row that lands on one into "unassigned"
  rather than letting it through as a decision.

- *Why is safety not just a very large weight?* Because a weight can always be
  outvoted — that is what a weighted sum means. The comparator was deliberately
  mutated into exactly that (a large arrival penalty added to cost) and every
  test still passed, because every HIGH_RISK fixture used a 14-minute arrival
  gap against a 10-point cost gap. The replacement test inverts both
  magnitudes — a 30-second arrival gap against an enormous cost gap — and
  asserts the two have opposite signs.

- *How do you know the solver does not write to the database?* Not by
  inspecting imports — that only proves it does not *know* about Prisma.
  `tests/solve.test.ts` counts rows in eight tables against real Postgres, runs
  a full solve, and counts again.

- *"Every processor is idempotent" — what does that rest on?* A real unique
  constraint on `(queue, idempotency_key)`, with the effect inside the *same*
  transaction as the log insert. Two concurrent deliveries race for real in
  `tests/queues.test.ts`; exactly one wins the INSERT and the loser's entire
  transaction, effect included, rolls back.

- *Why does an event published from the worker reach a browser connected to the
  web process?* Socket.IO's default adapter keeps room membership in one
  process's memory. The Redis adapter subscribes the web process's `Server` to
  a shared channel; a process with no `Server` publishes onto that channel with
  the Redis emitter instead.

- *The brief says respect carriageway direction — where is that logic?* There
  isn't any, on purpose. OSRM's graph is built from OpenStreetMap's real
  directional segments; divided highways are already two one-way ways. The
  carriageway-awareness lives in the decision to use real road routing rather
  than straight-line distance. Measured: two points 19 metres apart on opposite
  carriageways of the Outer Ring Road are 4.54km apart by road.

- *A driver and a fleet manager both have `read` on `job` — why does the driver
  see fewer rows?* Three layers in order: `can()` allows the action,
  `tenantScopeExtension` ANDs the tenant, `jobOwnershipExtension` ANDs
  `driverId`. A missing actor id ANDs an impossible value rather than widening.

- *You have a green test suite. How do you know the tests are worth anything?*
  A passing test is not evidence; the check is whether removing the production
  behaviour turns it red. Three times now that check has failed and been fixed:
  a Phase 3 safety test that could not fail, a Phase 7 ordering decision no
  test could distinguish from its opposite, and the Phase 8 lexicographic
  comparator above.

Not yet answerable: anything about measured dispatch quality across policies
(Phase 10), holds, offers, or the saga.

## 15. Things An Interviewer Can Attack

The most valuable section. In rough order of severity:

1. **Three plans, no way to act on one.** The dispatcher sees A, B and C and
   can do nothing with them. There is no path from a plan to an assignment
   until Phases 11–12, so the board is briefly *less* capable than it was at
   Phase 4, when a dropdown could at least assign a unit.
2. **No measured dispatch quality.** The engine produces the claimed behaviour
   on constructed scenarios, but nothing has compared global against nearest,
   or the three weight vectors against each other, on a realistic run. Phase 10
   is the whole point of the project and it does not exist yet.
3. **Every number in the model is invented.** Twenty-four durations
   (diagnose + resolve for twelve faults), two escalation constants, five
   weights × three vectors, `FUEL_AND_WEAR_PAISE_PER_KM`,
   `LABOUR_PAISE_PER_MINUTE`, the 4x carriageway ratio, the 45-minute service
   assumption, the 1.4 road factor, 30km/h, 0.65 bits, 0.8 coverage mass, the
   cap of 5. All plausible, all hand-set, none fitted to data. The objective
   function is only as good as they are.
4. **Zone partitioning demonstrably loses quality.** A job near a boundary
   loses a better cross-zone option, and `tests/solve.test.ts` proves it costs
   strictly more rather than only commenting that it might. Worse: partitioning
   is by the job's stored `zoneId`, not by geography, so a job labelled zone A
   that physically sits in zone B is partitioned by the label.
5. **No idempotency keys on external-facing mutations**, against an explicit
   project convention, on a product whose normal client is a phone on a bad
   connection. A retried intake creates a second job.
6. **The concurrency suite is empty**, and Phase 9 made it worse: deleting
   `assignUnit.ts` took the only two-dispatchers-one-unit race test with it.
   `npm run test:concurrency` starts no container and proves nothing.
7. **Accuracy numbers are self-referential.** The simulator generates symptoms
   from the same likelihood table the classifier inverts, so 72–77% top-fault
   accuracy measures how well entropy-driven questioning searches the model,
   not how well the model matches real breakdowns.
8. **Naive Bayes double-counts correlated evidence** — a battery light and a
   no-crank engine are two updates for largely one fact.
9. **Unscoped reads and writes behind a role check.** Intake writes with
   `prismaBase`, and `POST /solve` reads the whole fleet unscoped by design.
   Only the route's prior scoped lookup or its role gate keeps them tenant-safe
   — exactly the discipline-reliant failure the extensions removed for reads.
10. **No OSRM caching**, now that the solver calls it per re-plan over every
    pending job. Phase 6 flagged this as "revisit at Phase 9"; Phase 9 did not.
11. **`buildDispatchSnapshot` silently drops jobs** with no location or no
    fault hypothesis — they appear in neither the plans nor the unassigned
    list, and nothing is logged. Invariant 8 says every degraded state is
    visible to an operator; this one is not.
12. **Only chosen assignments get a cost breakdown persisted.** A feasible
    option that simply lost on cost is recorded nowhere, so "why not the nearer
    van?" is answerable for *rejected* options but not for *outranked* ones.
13. **`POST /solve` plans every pending job in the system on every press**,
    with no zone, tenant or count limit. `buildDispatchSnapshot` has a `jobIds`
    filter no caller passes.
14. **The exactly-once pattern does not reach an external effect.** Phase 15b's
    real notification delivery needs a genuinely different two-phase version.
15. **Bull Board grants unaudited operator power.** `queueAdmin: ['read']`
    undersells a UI that can retry, discard and promote jobs, none of it
    separately RBAC-checked or written to `AuditLog`.
16. **`isBasementLevel` matches `/^b/i`**, tied to the simulator's `B1`/`B2`
    format. A real payload saying `"Basement 2"` or `"-2"` would silently pass
    a flatbed through.
17. **Duplicate-answer protection is incidental**, falling out of the job-event
    unique constraint rather than anything that declares it.
18. **A required capability set can be unsatisfiable** — three contending
    faults can union into a set no seeded technician holds.
19. **The solver's debounce does not absorb a trigger arriving while the
    debounced job is already ACTIVE**, and `moveToDeadLetterIfTerminal` is not
    transactional with the terminal failure. Neither is exercised today.
20. **Jobs with events can never be deleted.** In production that collides with
    data-deletion obligations; the answer is anonymising in place or
    crypto-shredding, not a trigger exemption. No phase owns this.
21. **~50 of 83 tables have no reader**, and the frontend has no automated test
    at all — no browser has run the four pages.

## 16. How I Would Improve It

In the order I would actually do it: Phase 10's evaluation harness, because
every claim above about dispatch quality is currently a constructed scenario
rather than a measurement; then holds and the saga (11–12), which is what turns
a plan into an action; then idempotency keys on the two external mutations; a
travel-time cache; and a global event sequence for zone-wide replay.

## 17. Defensible Resume Claims

Only what is implemented, and for numbers, only what was measured on this
machine against a seeded simulator and a real local OSRM instance:

- Built a **dispatch solver that optimises expected time-to-resolution rather
  than time-to-arrival**: candidate generation over real road-network travel
  times, hard-constraint filtering with ten reason codes, a five-term cost
  function that sums over a fault probability distribution including the cost
  of a likely re-dispatch, and a lexicographic safety ordering above it.
  Measured: a 7km broad-capability unit beats a 2km jump-start-only unit,
  44.0 minutes expected resolution against 48.5.
- Implemented the **Hungarian algorithm from scratch** (row/column potentials,
  augmenting paths, rectangular padding) for global assignment across all
  pending jobs, verified against brute-force enumeration on 300 seeded
  matrices, with a scenario test showing global assignment fulfils a
  scarce-capability job that a nearest-first pass strands.
- Built an **entropy-driven intake** that chooses each question by expected
  information gain over a 12-fault distribution: measured 0.00 questions for a
  stated flat tyre against 3.17 for an unexplained no-start, with entropy
  before/after on every answer (mean realised gain +0.33 bits over 319
  answers).
- Deployed **self-hosted OSRM** from an OpenStreetMap extract with a full
  extract/partition/customize (MLD) pipeline, with per-origin haversine
  fallback and a degraded-estimate flag carried through to the operator.
  Verified direction-aware routing on real data: two points 19 metres apart on
  opposing carriageways measure 4.54km apart by road.
- Built **exactly-once queue processing** on BullMQ over at-least-once
  delivery, enforced by a Postgres unique constraint with the effect executed
  in the same transaction as the idempotency-log insert, proved with a genuine
  concurrent race against a real database.
- Built a **deterministic discrete-event simulator** driving the production
  intake path, verified byte-identical across runs of the same seed.
- Implemented **three-layer read authorisation** (RBAC table, tenant-scoping
  Prisma extension, row-ownership extension) that fails closed on a missing
  scope, with cross-tenant reads audited.
- Implemented a **transactional outbox** over Socket.IO with a Redis adapter
  for cross-process delivery, a per-job replay cursor and idempotent client
  apply.

Not claimable: measured dispatch quality against a baseline policy, latency,
throughput, or accuracy against real breakdowns.

## 18. Technical Vocabulary

- **Time-to-resolution vs time-to-arrival** — resolution is when the fault is
  fixed. Zippy optimises the first.
- **Shannon entropy** — uncertainty of a distribution in bits.
- **Expected information gain** — current entropy minus the average posterior
  entropy over the answers that might come back. Non-negative in expectation,
  not per answer.
- **Naive Bayes** — treat observations as independent given the fault; wrong
  but readable, and it double-counts correlated evidence.
- **The assignment problem** — choose one column per row minimising total cost,
  with no column reused. Not the same as each row taking its own best.
- **Hungarian algorithm** — solves it in O(n³) using dual variables
  ("potentials") kept so every reduced cost stays non-negative; a matching over
  zero-reduced-cost cells is optimal by LP duality.
- **Reduced cost** — `cost[i][j] - rowPotential[i] - colPotential[j]`.
- **Augmenting path** — an alternating path from an unmatched row to an
  unmatched column; flipping it grows the matching by one.
- **Rectangular padding** — adding dummy columns so every row has one; here
  they mean "this job gets nothing", which is an outcome, not a constraint.
- **Hard constraint vs soft cost** — a filter removes an option; a cost orders
  what survives. A large penalty is not a constraint, because enough other
  terms outvote it.
- **Lexicographic ordering** — compare on one key first, break ties with the
  next; safety sits above cost so it cannot be traded away.
- **Snapshot hash / content addressing** — fingerprint exactly the inputs that
  can change a decision, so the same hash means the same world.
- **At-least-once delivery with an exactly-once effect** — the queue may
  redeliver; a unique constraint plus a shared transaction makes the effect
  happen once.
- **TOCTOU** — time-of-check to time-of-use; why check-then-act loses to a
  constraint.
- **Dead-letter queue** — where a job goes when its retries are exhausted;
  distinct from a queue's own failed set.
- **Capped exponential backoff** — the cap matters because an uncapped retry
  and a hung job look identical from outside.
- **Optimistic locking** — detect a conflict with a version check instead of
  holding a row lock.
- **Transactional outbox** — buffer side effects during a transaction, emit
  after commit.
- **MLD vs contraction hierarchies** — OSRM's two mutually exclusive
  preprocessing pipelines; `--algorithm mld` requires partition + customize.
- **Fail-closed** — when a fact is missing, choose the restrictive answer.

## 19. Current Project State

**Phases 0–9 complete.** 234 tests across 16 files; `tsc --noEmit` and
`eslint src` clean.

Working:

- **Foundation** — two processes, Zod-validated env, pino with request ids,
  `/health` with real dependency checks, docker-compose for Postgres 16, Redis
  7 and OSRM.
- **Schema and seed** — 83 tables; append-only triggers on `job_events` and
  `ledger_entries`; an idempotent seed producing 6 zones, 24 units, 31
  technicians with a deliberately uneven capability matrix (exactly 2
  EV-certified, 3 key programmers, 18 OBD), 12 workshops, and 24/24 units
  crewed by a technician who can use the unit's rarest capability.
- **Auth and tenancy** — JWT pair, argon2id, permission table, tenant-scope and
  row-ownership Prisma extensions, audited cross-tenant reads.
- **Intake** — naive-Bayes rule table, Shannon entropy, expected information
  gain with four stop conditions, safety triage with reason codes, location
  refinement with carriageway direction, and a deterministic simulator.
- **Realtime** — Socket.IO with handshake JWT, three room types, one fan-out
  point, transactional outbox, Redis adapter for cross-process delivery,
  per-job reconnect replay with truncation.
- **Queues** — four BullMQ queues, capped exponential backoff, a real
  dead-letter queue, idempotent processors backed by a unique constraint,
  BullMQ-native debouncing, a repeatable cleanup sweep, Bull Board behind RBAC.
- **Routing** — self-hosted OSRM (MLD) on a Bengaluru extract, one-to-one and
  many-to-one, per-origin haversine fallback with a degraded flag.
- **The solver** — candidate generation over crewed pairs, ten feasibility
  reason codes, a per-fault duration model, a five-term cost function, three
  weight vectors, a lexicographic safety comparator, and a hand-written
  Hungarian assignment with zone partitioning above a configurable threshold.
- **Solver persistence** — `POST /solve` writes one `solver_runs` row with a
  snapshot hash and wall-clock, every rejected option with its reason code,
  every chosen assignment with its cost breakdown, and three `plan_variants`.
- **Frontend** — `/driver`, `/technician`, `/dispatcher` on one state object;
  the dispatcher board now shows three plan cards instead of a unit dropdown.

Not started: the evaluation harness (Phase 10), holds and real concurrency
(11), the reservation saga (12), re-dispatch and action tiers (13), the real
console (14), driver/technician surfaces (15), money (15c), the LLM (16), chaos
and degradation (17), and everything after.

**Unverified:** no browser has run the pages. The Phase 4 acceptance check —
three windows, three roles, an offline/online replay test — has never been
performed, and the Phase 9 dispatcher board has only been exercised through its
HTTP route, never clicked.
