# INTERVIEW.md

A living interview-prep document for the maintainer. It is maintained
automatically: one structured entry per phase goes into DECISIONS.log, and at
checkpoints (end of Phases 4, 9, 13, 17, 22) that log is consolidated in here
and cleared.

**State after Phase 4 (checkpoint).** Intake is real and measurable, the
realtime layer is real, and three crude surfaces run on it. Dispatch — the
thing the project is actually about — is **not built**. Sections below say so
where that is the honest answer.

---

## 1. Project Overview

Zippy is a roadside breakdown dispatch system. The thesis: optimise expected
**time-to-resolution**, not time-to-arrival. The nearest technician often
cannot fix the fault — dispatching them is fast to arrive and slow to resolve,
because a second dispatch then has to happen. Zippy computes the expected time
for the fault to actually be fixed, including the cost of a likely re-dispatch,
and allocates against that.

**That objective function does not exist yet.** After Phase 4 the system can
take a breakdown report, work out what is probably wrong and how dangerous the
situation is, and let a dispatcher assign a unit by hand. Choosing the unit is
Phases 6–9.

## 2. Architecture

- **Modular monolith**, two processes: `web` (`src/index.ts`) and `worker`
  (`src/worker.ts`). The worker is still a heartbeat — BullMQ is Phase 5.
- **Express** app built in `src/api/app.ts`, started in `src/index.ts`, so
  routes are testable without binding a port. Socket.IO shares the same HTTP
  server: one origin, one certificate, nothing extra to expose.
- **Postgres via Prisma is the source of truth.** Redis currently carries
  nothing but a `PING` and the simulator's kill switch.
- Layers, in dependency order:
  - `src/domain/` — pure. Fault rules, entropy, safety, location, geo. No
    Prisma, no clock, no `Math.random`. This is what the Phase 10 harness will
    replay, so anything impure here would destroy reproducibility.
  - `src/intake/` — the domain applied to the database in transactions.
  - `src/commit/` — mutation that races. One file so far (`assignUnit.ts`).
  - `src/realtime/` — Socket.IO, rooms, the fan-out point, the outbox.
  - `src/sim/` — the simulator, a production component, not a dev tool.
  - `src/engine/` — still empty. Candidates, feasibility, cost (Phase 6+).
- **No frontend build step.** `/public` is plain ES modules served statically;
  Bootstrap and morphdom come from a CDN, the Socket.IO client from our own
  server.

## 3. Request Lifecycles

**Intake** (`POST /jobs/intake` → `src/intake/createJob.ts`) is the one
complete lifecycle. In a single transaction it creates the `jobs` row, writes
a `symptom_reports` row and a `location_events` row, computes a fault
distribution and stores it as `fault_hypotheses`, triages safety onto
`Job.safetyLevel`, and appends five or six `job_events`. If the first
hypothesis is already certain enough it also writes `INTAKE_COMPLETED` and
asks nothing.

**Questioning** (`GET /jobs/:id/next-question`, `POST /jobs/:id/answers`)
loops until one of four stop conditions. Each answer writes an
`intake_answers` row carrying entropy before, entropy after and expected gain.

**Assignment** (`PATCH /jobs/:id/assign`) is a hand-picked placeholder,
deleted at Phase 9.

Dispatch, offer, en-route, completion and payment lifecycles: **not
implemented**.

## 4. Database

83 tables from Phase 1, most of them still unread — deliberately, so
migrations only ever grow. Actually exercised after Phase 4: `tenants`,
`users`, `tenant_memberships`, `drivers`, `vehicles`, `vehicle_profiles`,
`zones`, `capabilities`, `technicians`, `technician_capability`,
`technician_shifts`, `units`, `unit_capability`, `unit_stock`, `jobs`,
`job_events`, `symptom_reports`, `fault_hypotheses`, `intake_questions`,
`intake_answers`, `location_events`, `audit_logs`.

Two patterns carry the design:

- **Append-only log.** `job_events` and `ledger_entries` reject UPDATE and
  DELETE via a database trigger, not just a permission — the trigger was
  chosen because a superuser bypasses table privileges but not a BEFORE-ROW
  trigger that raises. Consequence, discovered the hard way: **a job that has
  events cannot be deleted at all**, by anyone.
- **Optimistic version column** on every row two actors can race (`units`,
  `jobs`, `unit_holds`, `dispatch_offers`, …). First real use is
  `src/commit/assignUnit.ts`.

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
GET  /units                   the assignment dropdown's options
PATCH /jobs/:id/assign        manual pick — PLACEHOLDER, deleted at Phase 9
```

Conventions held: typed errors mapped to status codes in one place per module
(`src/intake/errors.ts`, `AssignmentError`), a `JobEvent` on every state
transition, 404-not-403 for rows a caller may not see, strict Zod schemas so an
unknown key is a 400 rather than a silent strip.

Convention **not** held: idempotency keys. `CLAUDE.md` says every
external-facing mutation takes one; none do, and `idempotency_keys` is unread.

## 6. Auth

JWT access + refresh with separate secrets, argon2id hashing, and **three
layers of read authorisation**, each in its own file and none in a route
handler:

1. **RBAC** — `src/auth/permissions.ts`, a role → resource → action table
   behind one `can()`. Assignment is its own resource (`jobAssignment`)
   precisely because a TECHNICIAN has `update` on `job` for their own work and
   that must not extend to deciding who gets sent.
2. **Tenant scoping** — `src/infra/tenantScopeExtension.ts` injects a
   `tenantId` filter into every query on a tenant-scoped model. A query that
   loses its scope filters by `NO_TENANT`, an id that cannot exist, and returns
   nothing. A DISPATCHER reads across tenants and every such read writes an
   `audit_logs` row.
3. **Row ownership** — `src/infra/jobOwnershipExtension.ts` narrows a DRIVER to
   `driverId = theirs` and a TECHNICIAN to `assignedTechnicianId = theirs`, on
   top of the tenant filter, never instead of it.

The socket handshake uses the same `verifyAccessToken`, and `job:subscribe`
authorises through the same scoped client, so the realtime layer inherits all
three layers rather than reimplementing them.

## 7. Backend Concepts Used

Only what the code actually exercises:

1. **Shannon entropy and Bayesian updating** — `src/domain/entropy.ts`.
   `posterior ∝ prior × P(observation | fault)`, normalised.
2. **Expected information gain** — `src/domain/questionSelection.ts`. For each
   candidate question, average the posterior entropy over the answers that
   might come back, weighted by how likely each is; ask the question with the
   largest expected drop.
3. **Naive Bayes** — `src/domain/faultRules.ts`, a hand-written likelihood
   table, used in both directions: the classifier inverts it, the simulator
   generates from it.
4. **Poisson arrivals** — `src/sim/scenarios.ts`. Exponential inter-arrival
   times, because real queues form from bunching, not from even spacing.
5. **Seeded PRNG as a correctness requirement** — mulberry32 in
   `src/sim/random.ts`. `Math.random()` anywhere in the simulator would end
   reproducibility and with it the Phase 10 harness.
6. **Optimistic locking** — `src/commit/assignUnit.ts` claims a unit with
   `UPDATE … WHERE id = ? AND version = ? AND status = 'AVAILABLE'`, so the
   check and the claim are one statement.
7. **Transactional outbox** — `src/realtime/outbox.ts`. Job events are buffered
   during a transaction and published only after it commits, because the
   transaction can roll back and a browser cannot un-see an event.
8. **Append-only event log with per-job sequence numbers**, and the unique
   constraint that arbitrates two writers.
9. **AsyncLocalStorage for request-scoped context** — `src/auth/context.ts`,
   so the Prisma extensions can see who is asking without a threaded parameter.
10. **Prisma client extensions as an enforcement point** rather than
    discipline.
11. **Fail-fast config, structured logging with a request id, real dependency
    health checks, process separation, graceful shutdown** — from Phase 0, all
    still true.

## 8. Engineering Problems

**Solved and measurable:**

- *How many questions should intake ask?* Not a fixed form. Entropy decides,
  and the count varies with ambiguity — measured below.
- *How do you publish an event exactly when it is real?* Not from inside the
  transaction. The outbox.
- *How do two dispatchers not take the same unit?* The conditional update.

**Ahead, and the interesting ones:** the expected-time-to-resolution objective,
feasibility as filters with reason codes, the reservation saga and its
compensations, real-Postgres concurrency proofs, and the evaluation harness
that imports the production engine.

## 9. Concurrency

Three races exist in the code today.

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
  the event write rather than from anything that declares the intent, and
  `fault_hypotheses.version` has no unique constraint of its own.

- **Two dispatchers assigning the same unit.** `takeUnit()` claims with
  `WHERE id = ? AND version = ? AND status = 'AVAILABLE'`; zero rows changed
  means this writer lost. Unit and job move in one transaction, because taking
  the unit and then failing to attach it would strand it `ON_JOB` with no job.
  Proved with a real concurrent test in `tests/assign.test.ts`.

The testcontainers-backed concurrency suite (`npm run test:concurrency`) is
still empty; these tests run against the shared `zippy_test` database.

## 10. Failure Handling

- The process survives a dependency outage; `/health` degrades to 503.
- A rolled-back transaction publishes nothing, because the outbox flushes only
  after commit.
- A reconnecting socket replays what it missed from its cursor; a client that
  missed more than 500 events is told `truncated` and given nothing rather than
  a partial history it would trust.
- Delivery is **at-least-once** by choice: a resubscribe joins the room before
  reading the replay, so an event committed in that window arrives twice. The
  alternative loses it, and a duplicate is detectable while a gap is not. The
  client de-duplicates by sequence (`public/js/state.js`).

Retries, dead-letter queues, compensations, saga recovery: **not implemented**.

## 11. Security

- Secrets in `.env` only; `.env.example` holds placeholders.
- Three-layer read authorisation (§6), all enforced by Prisma extensions.
- Socket JWT verified **on the handshake**, so a live socket is always an
  authenticated socket; the token travels in `handshake.auth`, not the URL.
- Strict Zod schemas: a caller cannot set a server-derived field.
- Body capped at 1 MB; CORS reflects only allowlisted origins.

Not done: rate limiting, refresh-token revocation, idempotency keys.

## 12. Scaling

No measurements, none claimed. One structural limit worth knowing: **the
realtime outbox is in-process**, so job events written by the simulator process
are not broadcast by the web process. More than one web process would split the
room membership the same way. The fix is the Socket.IO Redis adapter, which
arrives naturally with Redis in Phase 5.

## 13. Design Decisions & Tradeoffs

Carried from `docs/STACK.md`: Postgres over Mongo; modular monolith over
microservices; no frontend build step; two processes from day one; optimistic
over pessimistic locking; self-hosted OSRM over a hosted maps API; BullMQ over
Kafka.

Added Phases 1–4:

- **Expected information gain over a hand-built decision tree or an LLM.** It
  is the direct formalisation of "ask what tells you most", it is pure
  arithmetic, and it makes question count fall out of ambiguity. A tree encodes
  the same maths worse and goes stale against the table. An LLM would break
  invariant 5 (it would be deciding) and invariant 10 (an external call inside
  a decision). Tradeoff: question quality is capped by the likelihood table,
  and nothing detects a badly modelled question.

- **Capability-set stability as a stop condition.** Once every fault still in
  contention resolves to the same capability, more questions cannot change who
  gets sent. This is what makes it a dispatch system rather than a diagnosis
  quiz. Tradeoff: four distinct stop reasons that must not be read as
  equivalent — `QUESTION_CAP_REACHED` is a worse outcome than
  `ENTROPY_BELOW_THRESHOLD`.

- **A fault a question does not model is UNIFORM over its answers.** A
  plausible-looking default row instead would quietly promote every fault the
  question forgot, every time a driver reports nothing unusual. That bug was in
  the file once and made a stuck vehicle look like a flat tyre.

- **Safety as a flat rule list producing reason codes, not a score.** Invariant
  4 puts safety in a lexicographic ordering above the cost function precisely
  so it cannot be traded off; a score would invite exactly that.

- **Derived facts are not client inputs.** `onHighway` is derived from the
  reported road position and feeds both the job column and the triage;
  `night` from the clock. Both were removed from the client schema after a bug
  where a highway breakdown triaged NORMAL. Strict schemas make an attempt to
  set them a 400.

- **Unknown road position fails CLOSED** (`UNKNOWN_POSITION`, ELEVATED),
  matching `NO_TENANT`/`NO_OWNER`. Over-triaging costs a marginally slower
  dispatch; under-triaging leaves a highway breakdown ranked on cost alone.

- **The simulator drives the real intake functions**, not a copy, because
  Phase 10 compares policies by replaying through them. Tradeoff: it runs
  sequentially and cannot exercise concurrent intake.

- **One fan-out point, publishing after commit.** Scattered emits are how a
  realtime system rots; emitting inside the transaction publishes events the
  database may still discard.

- **The reconnect cursor is per job**, because `job_events` has a unique
  `(job_id, sequence)` and no global counter, and `at` is not monotonic with
  insertion order (the simulator writes historical timestamps).

## 14. Interview Questions

Questions the code can answer today:

- *Why does "flat tyre" ask no questions and "my car will not start" ask about
  three?* Because the count is not scripted. `classifySymptoms` turns the
  payload into a distribution over 12 faults; a stated flat tyre lands at 0.518
  bits, already under the 0.65-bit threshold, so `decideNextQuestion` returns
  STOP. A bare no-start lands at 2.618 bits, so the selector scores every
  unasked question by expected information gain and asks the best, until
  entropy drops, every contending fault needs the same capability, or the cap
  of 5 is hit. Measured: `FLAT_TYRE` 0.00 questions, `WONT_START` 3.17.

- *You store entropy before and after every answer. What stops that being
  decoration?* It is the number the claim is made of, and it does not always
  move as expected: 244 of 319 answers reduced entropy, 75 raised it, mean
  realised gain +0.33 bits. That is correct — expected information gain is
  non-negative as a theorem about the average over possible answers, while one
  surprising answer legitimately makes you less sure. A test asserts the
  non-negativity of the expectation for every question against every belief.

- *A driver and a fleet manager both have `read` on `job` — why does the driver
  see fewer rows?* Three layers in order: `can()` allows the action,
  `tenantScopeExtension` ANDs the tenant, `jobOwnershipExtension` ANDs
  `driverId`. A missing actor id ANDs an impossible value rather than widening.

- *How do two dispatchers not take the same unit?* The check and the claim are
  one statement: `UPDATE units SET status='ON_JOB' WHERE id=? AND version=?
  AND status='AVAILABLE'`. Both pass the preceding read; only one changes a
  row. Unit and job move in the same transaction so a half-assignment cannot
  strand the unit.

- *Why not emit the socket event where you write the job event?* Because that
  write is inside a transaction that is deliberately retried on a sequence
  collision. Events go to a per-transaction outbox on AsyncLocalStorage and are
  published after commit; a failed attempt's buffer dies with the attempt.

- *You have a green test suite. How do you know the tests are worth anything?*
  A passing test is not evidence; a test that cannot fail protects nothing. The
  check is whether removing the production behaviour turns it red. In Phase 3 I
  wrote a safety test that could not fail — every HIGH_RISK rule already
  preceded every ELEVATED one, so "highest level" and "first level" were
  identical — and fixed the source, not the test, to make the property real.

- *Why is `/health` not just `return 200`?* A hardcoded 200 tells a load
  balancer the process is up and nothing about whether it can reach its
  database.

Not yet answerable: anything about the objective function, feasibility, the
saga, or measured dispatch quality.

## 15. Things An Interviewer Can Attack

The most valuable section. In rough order of severity:

1. **There is no dispatch.** The project's thesis — expected time-to-resolution
   as an objective — is not implemented. Assignment is a dropdown.
2. **No idempotency keys**, against an explicit project convention, on a
   product whose normal client is a phone on a bad connection. A retried
   intake creates a second job.
3. **Accuracy numbers are self-referential.** The simulator generates symptoms
   from the same likelihood table the classifier inverts, so 72–77% top-fault
   accuracy measures how well entropy-driven questioning searches the model,
   not how well the model matches real breakdowns. It cannot expose model
   misspecification by construction.
4. **Naive Bayes double-counts correlated evidence** — a battery light and a
   no-crank engine are two updates for largely one fact, so confidence is
   overstated and should not be quoted as calibrated.
5. **Unscoped writes behind a scoped read.** The intake and assignment services
   write with `prismaBase`; only the route's prior scoped lookup keeps them
   tenant-safe. A future route that forgets is a leak — exactly the
   discipline-reliant failure the extensions removed for reads.
6. **Duplicate-answer protection is incidental**, falling out of the job-event
   unique constraint rather than anything that declares it.
7. **The outbox is in-memory and per-process**, so simulator-written events
   never reach web-process sockets, and a second web process would split rooms.
8. **The reconnect cursor is per job**, so a dispatcher watching a zone cannot
   replay and must refetch. Needs a global event sequence — Phase 14.
9. **Hand-tuned constants with no validation set**: 0.65 bits, 0.8 coverage
   mass, cap of 5, 0.02 minimum gain, and the simulator's volunteer rates.
10. **A required capability set can be unsatisfiable** — three contending
    faults can union into a set no seeded technician holds.
11. **Jobs with events can never be deleted.** In production that collides with
    data-deletion obligations; the answer is anonymising in place or
    crypto-shredding, not a trigger exemption. No phase owns this.
12. **The concurrency suite is empty.** `npm run test:concurrency` starts no
    container and proves nothing yet; the real-Postgres tests that exist share
    one database and cannot tear down.
13. **~55 of 83 tables have no reader**, and the frontend has no automated test
    at all — no browser has run the three pages.

## 16. How I Would Improve It

In the order I would actually do it: idempotency keys on the two mutations;
the Socket.IO Redis adapter so the simulator can feed a deployed board; a
global event sequence for zone-wide replay; then Phases 6–9, which are the
point of the project.

## 17. Defensible Resume Claims

Only what is implemented, and for numbers, only what was measured on this
machine against a seeded simulator:

- Built an **entropy-driven intake** that chooses each question by expected
  information gain over a 12-fault distribution, so question count tracks
  ambiguity rather than a fixed form: measured 0.00 questions for a stated flat
  tyre against 3.17 for an unexplained no-start, with entropy before/after
  recorded on every answer (mean realised gain +0.33 bits over 319 answers).
- Built a **deterministic discrete-event simulator** that drives the production
  intake path — Poisson arrivals, configurable fault and situation mix — and
  verified byte-identical output across runs of the same seed, which is what
  makes the planned policy comparison reproducible.
- Implemented **three-layer read authorisation** (RBAC table, tenant-scoping
  Prisma extension, row-ownership extension) that fails closed on a missing
  scope, with cross-tenant reads audited.
- Implemented a **transactional outbox** over Socket.IO so events publish only
  after commit, with a per-job replay cursor and idempotent client apply.

Not claimable: dispatch quality, latency, throughput, or accuracy against real
breakdowns.

## 18. Technical Vocabulary

- **Time-to-resolution vs time-to-arrival** — resolution is when the fault is
  fixed. Zippy optimises the first.
- **Shannon entropy** — uncertainty of a distribution in bits; 0 when certain,
  log₂(n) when uniform.
- **Expected information gain** — current entropy minus the average posterior
  entropy over the answers that might come back. Non-negative in expectation,
  not per answer.
- **Naive Bayes** — treat observations as independent given the fault; wrong
  but readable, and it double-counts correlated evidence.
- **Poisson process / exponential inter-arrival times** — the standard model
  for independent arrivals at an average rate; produces bunching.
- **Optimistic locking** — detect a conflict with a version check instead of
  holding a row lock.
- **Transactional outbox** — buffer side effects during a transaction, emit
  after commit.
- **At-least-once delivery with idempotent apply** — the receiver, not the
  sender, removes duplicates.
- **Fail-closed** — when a fact is missing, choose the restrictive answer
  (`NO_TENANT`, `NO_OWNER`, `UNKNOWN_POSITION`).
- **Lexicographic ordering** — compare on one key first and only break ties
  with the next; safety sits above cost so it cannot be traded away.

## 19. Current Project State

**Phases 0–4 complete.** 131 tests across 9 files; `tsc --noEmit` and
`eslint src` clean.

Working:

- **Foundation** — two processes, Zod-validated env, pino with request ids,
  `/health` with real dependency checks, docker-compose for Postgres 16 and
  Redis 7.
- **Schema and seed** — 83 tables; append-only triggers on `job_events` and
  `ledger_entries`; an idempotent seed producing 6 zones, 24 units, 31
  technicians with a deliberately uneven capability matrix (exactly 2
  EV-certified, 3 key programmers, 18 OBD), 12 workshops, and 24/24 units
  crewed by a technician who can use the unit's rarest capability.
- **Auth and tenancy** — JWT pair, argon2id, permission table, tenant-scope
  and row-ownership Prisma extensions, audited cross-tenant reads.
- **Intake** — hand-written naive-Bayes rule table, Shannon entropy, expected
  information gain with four stop conditions, safety triage with reason codes,
  location refinement with first-class carriageway direction, and a
  deterministic simulator (`npm run sim`).
- **Realtime** — Socket.IO with handshake JWT, three room types, one fan-out
  point, transactional outbox, per-job reconnect replay with truncation.
- **Frontend** — `/driver`, `/technician`, `/dispatcher` on one state object,
  rows patched by `data-job-id`, morphdom only where content changes shape.
- **Manual assignment** — `PATCH /jobs/:id/assign`, dispatcher-only, honouring
  one-active-job-per-unit via a conditional update. Deleted at Phase 9.

Not started: BullMQ and the worker's real job (Phase 5), OSRM and candidate
generation (Phase 6), feasibility (7), the cost function (8), allocation (9),
the evaluation harness (10), holds and the saga (11–12), re-dispatch (13), the
real console (14), money (15c), the LLM (16), chaos (17), and everything after.

**Unverified:** no browser has run the three pages. The Phase 4 acceptance
check — three windows, three roles, an offline/online replay test — has not
been performed.
