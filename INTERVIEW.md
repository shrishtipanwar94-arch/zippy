# INTERVIEW.md

A living interview-prep document for the maintainer. It is maintained
automatically: one structured entry per phase goes into DECISIONS.log, and at
checkpoints (end of Phases 4, 9, 13, 17, 22) that log is consolidated in here
and cleared.

**State after Phase 17 (checkpoint — core complete).** The thesis is
implemented, measured, surfaced and breakable on purpose. A job goes from free
text (or a symptom picker) to three ranked, globally assigned plans through a
pure engine; a dispatcher turns one into a real reservation through a three-leg
saga; a technician who finds something different triggers a re-solve; the work
is priced, approved, paid, booked to a double-entry ledger and paid out. Three
browser surfaces exist and have been used. An LLM fills in the intake form and
has been measured against a keyword control. Every failure mode has a rung on a
degradation ladder, a switch that forces it, and a banner that names it.

What does not exist: parts and inventory (18), the parts-aware feasibility that
depends on it (19), and everything after.

---

## 1. Project Overview

Zippy is a roadside breakdown dispatch system. The thesis: optimise expected
**time-to-resolution**, not time-to-arrival. The nearest technician often
cannot fix the fault — dispatching them is fast to arrive and slow to resolve,
because a second dispatch then has to happen.

**That objective function exists, and it has been measured against
alternatives rather than asserted.** `npm run eval` replays five seeded
scenarios through the production engine against four policies. On the baseline
scenario the inversion the project is built on shows up directly:
`nearest-unit` posts the best arrival time (20.1 min) while
`capability-aware-global` resolves more jobs (54/60 against 53/60). On two of
the five scenarios global **loses**, and the report says so — see §15.

Assignment is **global**: `src/engine/allocation.ts` solves the whole pending
board as one assignment problem, so a job whose only possible unit would have
been taken by an earlier, marginally better match is not stranded.

## 2. Architecture

- **Modular monolith**, two processes: `web` (`src/index.ts`) and `worker`
  (`src/worker.ts`). The worker runs four BullMQ queues and, from Phase 12,
  runs saga recovery before any queue starts.
- **Postgres via Prisma is the source of truth** (invariant 1). Redis carries
  queues, BullMQ's dedup state, and the Socket.IO adapter's pub/sub — never a
  hold or a reservation.
- **Self-hosted OSRM** with a haversine fallback. Invariant 10 says no external
  API sits in a decision path; a local, versioned map extract is what makes
  routing reproducible.
- Layers, in dependency order:
  - `src/domain/` — pure. Fault rules, entropy, safety, geo, **replan
    triggers**, **action tiers**. No Prisma, no clock, no `Math.random`.
  - `src/engine/` — the solver. Candidates, feasibility, durations, cost,
    ranking, allocation, solve. **Zero imports from prisma or redis**, checked
    by a standing grep, and it writes nothing.
  - `src/intake/` — the domain applied to the database in transactions.
  - `src/commit/` — everything that mutates, and the reads that feed the
    engine: `dispatchSnapshot`, `persistSolverRun`, `holds`, `offers`, `saga`,
    `sagaRecovery`, `actionRequests`, `redispatch`, `slaEscalation`.
  - `src/queues/` + `src/workers/` — connections, backoff, idempotency,
    debounce, dead-letter, and one processor per queue.
  - `src/realtime/` — Socket.IO, rooms, the fan-out point, the outbox.
  - `src/sim/` — the simulator, a production component, not a dev tool.
  - `/evaluation` — the harness. Imports the production engine; contains no
    second solver, asserted by a test.
- **Three separate Redis connection families**, because their requirements are
  mutually incompatible: health checks must fail fast, BullMQ's blocking fetch
  *requires* `maxRetriesPerRequest: null`, and a pub/sub connection is locked
  into subscriber mode the moment it subscribes.
- **No frontend build step.** `/public` is plain ES modules served statically.

## 3. Request Lifecycles

**Intake** (`POST /jobs/intake`) creates the job, symptom report, location
event, fault hypothesis, safety triage and five or six `job_events` in one
transaction.

**Questioning** (`GET /jobs/:id/next-question`, `POST /jobs/:id/answers`) loops
until one of four stop conditions, recording entropy before, after and expected
gain on every answer.

**Solve** (`POST /solve`) reads a snapshot, generates candidates, filters them,
scores every survivor under three weight vectors, runs the Hungarian assignment
once per vector, persists a `SolverRun` with every rejected option and its
reason code, and returns three plans. Nothing is reserved.

**Re-dispatch** (`POST /jobs/:id/diagnosis`) is the signature flow. The
technician on site files what they actually see; the belief is replaced and the
required capabilities recomputed. If the crew already there can still resolve
it, nothing moves and an AUTO action notifies the driver. If not, a re-solve
runs and raises a **RECOMMEND** action carrying the impact — from, to, expected
resolution time, cost, and whether the current crew survives the new plan.

**Reservation** (`POST /actions/:id/execute`) is where a plan becomes real. The
saga acquires a version-checked unit hold, offers the job to the technician,
and — for tows — offers a destination. Any leg failing compensates the rest in
reverse. If the new plan does not use the crew already on site, they are
explicitly released at this point, not when the recommendation was raised.

Money, chat, and the completion ladder: **not implemented**.

## 4. Database

83 tables from Phase 1. Actually exercised after Phase 13: the intake and auth
tables from earlier phases, plus `job_processing_log`, `solver_runs`,
`dispatch_options`, `plan_variants`, `unit_holds`, `technician_offers`,
`dispatch_offers`, `destination_offers`, `action_requests`, `approval_records`.

Four patterns carry the design:

- **Append-only log.** `job_events` and `ledger_entries` reject UPDATE and
  DELETE via a database trigger — a superuser bypasses table privileges but not
  a BEFORE-ROW trigger that raises. Consequence: **a job with events cannot be
  deleted at all**.
- **Optimistic version column** on every row two actors can race. The
  conditional `UPDATE … WHERE id = ? AND version = ? AND status = ?` is the
  concurrency argument, and it is written out longhand in `holds.ts` because
  that is the one place legibility is the product.
- **Unique constraint as the idempotency mechanism.**
  `job_processing_log(queue, idempotency_key)` is what "every processor is
  idempotent" rests on.
- **Saga state persisted on `dispatch_offers.state`**, so a process that dies
  mid-reservation leaves something a restart can finish or undo.

Money is integer paise. Anything originating outside Zippy records both
`event_time` and `received_at`.

## 5. API Design

```
POST /auth/login | /auth/refresh
GET  /health                  real SELECT 1 + PING, 503 when a dep is down
GET  /jobs | /jobs/:id        scoped + ownership-narrowed
POST /jobs/intake             symptom payload -> job + hypothesis + question
GET  /jobs/:id/next-question  the entropy selector's decision
POST /jobs/:id/answers        record one answer, get the next step
POST /jobs/:id/diagnosis      TECHNICIAN only — re-diagnose on site, re-solve
POST /solve                   plan every pending job -> three plans, DISPATCHER
GET  /actions                 the RECOMMEND and APPROVE queues, DISPATCHER
POST /actions/:id/execute     take a RECOMMEND — starts the reservation saga
POST /actions/:id/approve     sign off (or reject) an APPROVE, approver recorded
GET  /admin/queues            Bull Board, DISPATCHER only
```

Conventions held: typed errors mapped to status codes in one place per module,
a `JobEvent` on every state transition, 404-not-403 for rows a caller may not
see, strict Zod schemas so an unknown key is a 400.

Convention **not** held: idempotency keys. `CLAUDE.md` says every
external-facing mutation takes one; none do.

## 6. Auth

JWT access + refresh with separate secrets, argon2id hashing, and **three
layers of read authorisation**, each in its own file and none in a route
handler: an RBAC table behind one `can()`; a tenant-scoping Prisma extension
that filters by `NO_TENANT` when scope is missing; a row-ownership extension
narrowing a DRIVER or TECHNICIAN to their own jobs.

Resources are deliberately finer-grained than the models. `jobDiagnosis` is
TECHNICIAN-only and separate from `job`: a dispatcher may update a job without
being the person standing at the roadside looking at the engine, and only that
person should overwrite what the fault is. `solverRun`, `actionRequest` and
`queueAdmin` are DISPATCHER-only for the same reason.

`POST /solve` is the deliberate exception: it reads on the **unscoped** client,
because a fleet-wide plan that quietly ignored units the dispatcher commands
would be worse than no plan. The role check is the only thing protecting it.

## 7. Backend Concepts Used

Only what the code actually exercises:

1. **Shannon entropy, Bayesian updating, expected information gain** —
   `src/domain/entropy.ts`, `questionSelection.ts`.
2. **Expected value over a distribution as a decision input** —
   `src/engine/cost.ts`. A pair that cannot resolve a fault carries that
   fault's probability × the cost of a second dispatch.
3. **Hard constraints as filters, never penalties** — `feasibility.ts` returns
   `{ option, code, detail }` and *removes* infeasible options. A penalty large
   enough to act like a constraint is a constraint with a latent bug.
4. **Lexicographic ordering above the cost function** — `ranking.ts`, in its
   own file so it cannot drift into being a sixth weighted term.
5. **The assignment problem and the Hungarian algorithm** — written by hand.
   Row and column potentials, reduced cost kept non-negative, augmenting paths
   through zero-reduced-cost cells. LP duality is why such a matching is
   provably optimal.
6. **Brute-force differential testing** — 300 seeded matrices, every
   permutation enumerated. "It returned an assignment" proves nothing.
7. **Content-addressed snapshot hashing** — fingerprints exactly the inputs
   that can change a decision, including zone centroids.
8. **Discrete-event simulation** — `/evaluation/runner.ts`. An event queue, not
   a time step, with a hidden `trueFault` the solver never sees, which is what
   makes first-visit failure and re-dispatch emerge rather than be asserted.
9. **Optimistic concurrency as a conditional UPDATE** rather than a row lock,
   because the transaction after a dispatch decision waits on a human.
10. **The ABA problem**, and the version column as the thing that distinguishes
    "the row I decided on" from "a row that has been round the block since".
11. **The saga pattern** — three legs, compensations in reverse order of
    acquisition, and crash recovery over persisted state. Not 2PC, because a
    technician's phone cannot hold a prepared transaction open.
12. **Idempotent compensation** as a shape: conditional update, report what you
    found, never throw.
13. **At-least-once delivery vs exactly-once effects** — the log row and the
    effect commit in one transaction.
14. **Job deduplication as a debounce** — measured: ten triggers fired in 32ms
    produce **one** solver run.
15. **Action tiering as a table**, not scattered if-statements — the same shape
    as the permission table, for the same reason.
16. **Gini coefficient** as a distributional measure, computed over all
    technicians including those who earned nothing.
17. **Transactional outbox**, **AsyncLocalStorage request context**, **Prisma
    extensions as an enforcement point**, **capped exponential backoff and a
    real dead-letter queue**, **testcontainers**.

## 8. Engineering Problems

**Solved and measured:**

- *How many questions should intake ask?* Entropy decides. `FLAT_TYRE` 0.00
  questions, `WONT_START` 3.17.
- *Why send the further unit?* Expected time to resolution sums over the whole
  fault distribution: 48.5 min for a near narrow crew against 44.0 for a
  further broad one.
- *Does global assignment actually beat greedy?* Measured across five
  scenarios. Sometimes, and the harness prints when it does not.
- *What does a scale approximation cost?* Zone partitioning: 11 of 180 jobs at
  monsoon-surge, 6 of 60 at ambiguous-diagnosis.
- *How do two dispatchers not take one unit?* 50 concurrent holds on 10 units
  grant exactly 10, against a real Postgres in a container.
- *How do you stop a burst of triggers becoming a burst of solves?* Debounce by
  zone. Ten triggers in 32ms → one solver run.

**Ahead:** the console (14), the driver and technician surfaces (15), chat and
event promotion (15b), money (15c), the LLM (16), chaos (17).

## 9. Concurrency

**The testcontainers-backed suite is real and runs against a Postgres 16
container the test starts** — `npm run test:concurrency`, 9 tests across 2
files, ~17 seconds. Not the shared dev database, not mocks. A proof that only
runs if someone remembered to start a database is not a proof.

- **Two dispatchers hold the same unit.** One statement does the check and the
  claim: `UPDATE units SET status='HELD', version=version+1 WHERE id=$1 AND
  status='AVAILABLE' AND version=$2`. Zero rows means you lost. At 50-on-10,
  exactly 10 succeed.
- **A stale plan claims a unit that has been round the block.** This is what
  the version column actually protects — see §14, because it is not what it
  looks like.
- **A technician accepts as the offer expires.** Both paths are the same
  conditional update guarded by `status = 'PROPOSED'`. Tested 12 times in a
  row, because a race that resolves correctly once may only have done so
  because one side was slower.
- **Release called twice.** Conditional on `(id, status, version)`; only the
  winner frees the unit, and only `WHERE status = 'HELD'`. Asserted by the
  unit's version moving exactly twice — a double free is invisible in the
  status but shows as a third increment.
- **A hold expires mid-commit.** `consumeHold` requires `status='ACTIVE' AND
  expires_at > now` in one statement; the unit stays HELD rather than moving to
  ON_JOB.
- **A process dies mid-saga.** Legs are committed deliberately, so a crash
  leaves real partial state. `recoverSagas` at worker startup commits
  ALL_ACCEPTED sagas and compensates everything else stale.
- **An offer times out while its saga waits.** Fixed in Phase 13: the
  offer-expiry worker now advances the saga, which compensates and releases the
  unit. Previously the van stayed reserved for a technician who had gone quiet
  until the recovery sweep noticed.
- **The world moves under a snapshot.** Deliberately not handled in the solver:
  a plan is a recommendation, and the version-checked hold at commit time is
  what validates a stale decision.

**From Phases 14–17:**

- **Two dispatchers select competing plans for the same job.** A unique index
  on `(job_id, solver_run_id)` in `decision_records` arbitrates: the second
  write fails rather than recording two decisions for one solve.
- **A message arrives while a promotion is being confirmed.** Promotions are
  FLAGGED proposals; confirming one is a conditional update on `status =
  'FLAGGED'`, so two confirmers produce one job change and one no-op.
- **A capture races the authorisation retry sweep.** Both are keyed on the
  payment's idempotency key, so the second is a no-op that returns the first
  one's result rather than charging twice.
- **Two probes finish at once with different verdicts** (17). Last write wins
  deliberately — the later reading is the more recent truth, and `since` only
  moves on an actual state change, so "how long has it been down" survives a
  burst of identical writes.
- **A chaos switch flips mid-solve** (17). The switch is read once at the edge
  and passed into the engine as a plain number, so a run finishes under the
  deadline it started with. A solve is a pure function over a snapshot, and its
  deadline is part of that snapshot.
- **Two dispatchers decide the same escalation** (17). Read-then-create with no
  unique index behind it: the worst case is two OPEN escalations with one
  decision each rather than a lost decision. Named in §15.

Assumption relied on throughout: **READ COMMITTED**, Postgres's default. At
that level a blocked UPDATE re-reads the row rather than failing; the guarantee
would be different under REPEATABLE READ.

## 10. Failure Handling

- The process survives a dependency outage; `/health` degrades to 503.
- **OSRM down is a degraded state, not an outage** — every travel estimate
  carries `degraded: true` and the flag travels *with the option* to the
  dispatcher (invariant 8). A partial batch degrades per-origin.
- Capped exponential backoff, five attempts, and a real cross-queue dead-letter
  queue populated only on terminal failure.
- **Compensations exist and are idempotent.** Releasing a hold twice, or
  compensating a saga twice, is a no-op rather than a double free.
- **Crash recovery exists**: `recoverSagas` runs before the workers start.
- A rolled-back transaction publishes nothing; the outbox flushes after commit.
- Delivery is at-least-once by choice — a duplicate is detectable, a gap is
  not.
- **A late job is still dispatched.** Phase 13 stopped `SLA_UNREACHABLE`
  applying once the window has closed: refusing to send a van to a job you are
  already late for converts a late arrival into no arrival.
- **There is a degradation ladder** (17), six components and three modes, in
  `src/domain/healthLadder.ts`. DEGRADED means something is doing a simpler job
  — the symptom picker instead of the model, polling instead of pushes, the
  best plan found instead of the best plan there is. CRITICAL means the system
  is no longer deciding and a person is, through a defined manual workflow with
  every write still audited. A component can never push the system past its own
  worst case, so a broken symptom assistant cannot black out the console.
- **The health loop is a bare timer in the worker, not a queued job** — the
  queue runs on Redis, and Redis being down is one of the states the loop
  exists to report. Fifteen seconds, every transition logged.
- **Payment failure never blocks dispatch** (15c): the job dispatches, the
  payment is PENDING_AUTHORISATION, and the operator sees the flag.
- **UNSERVICEABLE is a handover, not an end state** (17). The escalation card
  gives the dispatcher the feasibility reason code, the closest option a human
  could actually clear and why it was refused, an alternative outside the
  fleet, a recommendation, and three audited actions.

## 11. Security

Secrets in `.env` only. Three-layer read authorisation enforced by Prisma
extensions. Socket JWT verified on the handshake, token in `handshake.auth`
rather than the URL. Strict Zod schemas. Body capped at 1 MB; CORS reflects
only allowlisted origins. Bull Board mounted per-route behind `authenticate` +
`requirePermission`.

Not done: rate limiting, refresh-token revocation, idempotency keys, and any
audit trail for actions taken *through* Bull Board's UI.

## 12. Scaling

One real timing exists: a zone-wide solve over 888 candidate options with 179
feasible took **835ms**. Everything else below is structural, not measured.

- **The assignment is O(n³) in jobs**, which is why zone partitioning exists
  above a configurable option count. Its cost is now measured (§15.3).
- **The solver re-queries OSRM on every run** with no cache — O(jobs × units)
  routing work, batched per job but shared between jobs not at all.
- **The realtime outbox is in-process**, but the Socket.IO Redis adapter makes
  cross-process delivery work.
- **Exactly-once processing is Postgres-bound** and does not extend to an
  external effect at all.

## 13. Design Decisions & Tradeoffs

Carried from `docs/STACK.md`: Postgres over Mongo; modular monolith; no
frontend build step; two processes; optimistic over pessimistic locking;
self-hosted OSRM; BullMQ over Kafka.

**Intake (1–4).** Expected information gain over a decision tree or an LLM — an
LLM would break invariant 5 and invariant 10. Capability-set stability as a
stop condition, which is what makes it a dispatch system rather than a
diagnosis quiz. A fault a question does not model is UNIFORM over its answers.
Safety as reason codes, never a score. Derived facts are not client inputs.
Unknown road position fails CLOSED.

**Queues (5).** Exactly-once effects enforced by a unique constraint with the
effect inside the same transaction — a check-then-act has a TOCTOU window the
constraint closes. Debounce built on BullMQ's own deduplication rather than the
jobId-collision trick. Three Redis connection families. A real cross-queue
dead-letter queue.

**Routing and candidates (6).** An Overpass bounding-box export over a country
extract. `travelEstimateDegraded` on the option itself, because invariant 8
means the flag must travel with the thing a dispatcher looks at.
`coveredFaultProbability` sums over all twelve faults while
`missingCapabilities` uses the contending set — two different questions.

**Feasibility (7).** One code per rejection, first match wins, in a fixed
order. `VEHICLE_TYPE_INCOMPATIBLE` checked against the unit's KIND
independently of capability codes — defence in depth against a data error.

**Cost (8).** The lexicographic comparator lives in `ranking.ts`, not
`cost.ts`, so it cannot become a sixth weighted term. Every term keeps its
natural unit so a breakdown reads "44 minutes / 7 km" rather than "0.62 /
0.35". `slaRisk` measures window consumption, not breach probability, because
feasibility already removed the breaches.

**Allocation (9).** The matrix is jobs × UNITS, because the constraint is
invariant 7. A large finite sentinel rather than `Infinity`, because
`Infinity - Infinity` is `NaN`. `hungarian` throws on `rows > cols` rather than
trusting its caller — a hang is the worst failure available in a dispatch path.
All three plans from one candidate-generation pass.

**Evaluation (10).** The harness passes `haversineTravelTimes` rather than
calling OSRM: a scenario replayed 120 times cannot afford a round trip per job,
and a run that fell back mid-way would produce two answers from one seed. All
four policies run the production candidate generator and feasibility filter, so
the only variable is which feasible option gets chosen — a baseline that
ignored capability constraints would lose for the wrong reason. The global
policy always reads BALANCED, fixed up front, because picking the
best-performing vector after seeing results is the tuning the phase forbids.
`solverWallClockP95` goes to stderr because a millisecond cannot be
byte-identical and the determinism check is what makes this a measurement.

**Holds and offers (11).** Raw SQL for the conditional update, because the
WHERE clause *is* the concurrency argument. Release frees the unit only inside
the branch that moved the hold, and only `WHERE status = 'HELD'` — a late
release must not free a van that has since been legitimately dispatched.
`consumeHold` folds the expiry check into the same WHERE clause.

**The saga (12).** Compensations in reverse order of acquisition: releasing the
unit first would leave a technician holding an offer for a van somebody else
took. A technician released after ACCEPTING gets a different event from one
withdrawn unanswered, because one has already started driving. Recovery
compensates everything non-terminal except ALL_ACCEPTED, which it commits.

**Re-dispatch and tiers (13).** The trigger list lives in one place, as a
value. `MATERIAL_MOVE_METRES` (250) is what stops "driver moved" being every
GPS ping. Thrash control sits *before* the solve, because the cost being
defended against is the oscillation. A re-solve producing the same assignment
is a NO-OP that raises nothing — without that, every trigger looks like churn
and a system that re-solved ten times and changed nothing is indistinguishable
from one that reassigned ten times. The old crew is released on EXECUTE, not on
propose, because while the recommendation sits in a queue they are still the
assignment.

**The SLA decision (13).** `SLA_UNREACHABLE` now applies only while the
deadline is still in the future. Phase 10 proposed a ninth re-plan trigger for
the moment a window closed; auditing the trigger sources showed it would have
been useless, because a re-solve returns exactly what it returned a minute
earlier — the clock removed the options, not the fleet. The bug was in the
filter. The breach escalation is **RECOMMEND, not APPROVE**: APPROVE blocks
pending sign-off, so tiering an already-late job that way would make it wait
longer for a human to acknowledge that it is late.

**Console and surfaces (14–15).** The console renders the DECISION RECORD, not
a re-solve — a screen that recomputes answers a slightly different question and
quietly disagrees with the timeline beside it. Every sentence a driver reads is
worded on the server (`GET /jobs/:id/driver-view`), so no status enum can leak
into a browser; the test suite checks that rather than trusting the habit. A
dispatcher picks between whole PLANS, not units one at a time, because picking
units one at a time is exactly the greedy behaviour that strands jobs.

**Chat and promotion (15b).** A message never changes a job. Classification
produces a FLAGGED proposal and a human confirms it, so there is no code path
from "a message arrived" to "the technician was sent somewhere else". Who may
confirm which KIND is a separate question from who owns the job — a dispatcher
may correct a location and may not confirm a safety change, because they cannot
see the traffic.

**Money (15c).** Integers in paise, never floats. A job pins its price list at
creation and is never re-priced, because the customer agreed to one set of
numbers. Every movement is double-entry and the suite asserts the books balance
after every money test. Cash collection drives a technician's balance negative
and the payout nets it rather than sending a negative transfer. The estimate
re-approval tolerance is a configurable commercial policy, not a constant.

**GenAI (16).** The model fills in the symptom FORM; the Phase 3 rule table
still produces the probabilities. A distribution emitted by a model is a
decision wearing a probability's clothes, and nothing downstream could tell a
hallucinated 0.4 from a derived one. The driver confirms or corrects before
anything dispatches, and `/describe` creates nothing. One retry, and only for a
schema-invalid body — a refused connection will refuse again, and three failed
calls is 24 seconds of a stranded driver watching a spinner. Two providers
(Anthropic Messages API, OpenAI-compatible chat completions) behind one
`SchemaCall` boundary.

**Chaos and degradation (17).** The chaos switches live in Postgres because the
API and the worker are two processes and Redis is one of the things the board
can switch off. The chaos routes are ABSENT in production, not forbidden — a
403 is a permission check and permission checks have bugs. WebSocket chaos
refuses the handshake rather than dropping messages, because a client that
believes it is connected and is silently missing events is a worse and less
visible failure. The AI's health is read from the append-only attempt log
rather than from its own summary row — the first version read the row it was
about to write, refreshed its own timestamp every tick, and could never clear.

## 14. Interview Questions

- *Why does "flat tyre" ask no questions and "my car will not start" ask three?*
  The count is not scripted. A stated flat tyre lands at 0.518 bits, under the
  0.65 threshold, so the selector stops. A bare no-start lands at 2.618 bits.
  Measured: 0.00 against 3.17.

- *Why does a 7km unit beat a 2km one?* With a genuinely uncertain diagnosis the
  2km unit can only jump-start, so half the probability mass ends in a second
  dispatch — coordination, a replacement's travel, then the repair. 48.5
  minutes against 44.0.

- *Why implement the Hungarian algorithm rather than importing one?* This is the
  decision a dispatcher is most likely to challenge — "why did the van two
  streets away go to the other job?" — and "the library said so" is not an
  answer. Potentials, reduced costs kept non-negative, augmenting paths, and LP
  duality as the optimality proof. Checked against brute force on 300 matrices.

- *Your evaluation says the global policy loses two of five scenarios. Why ship
  it?* Because the harness also says why, and the reason is not the objective
  function. Running monsoon-surge twice with nothing changed but the
  zone-partition threshold: partitioned resolves 58/180, the whole-fleet matrix
  resolves 69/180. The scale approximation on top of the objective is what
  costs the throughput.

- *You have a version column AND a status check. Isn't one redundant?* No, and I
  only know because I deleted one and measured. Removing `AND version = $2`
  does **not** break the two-dispatchers test: at READ COMMITTED the second
  UPDATE blocks on the row lock, re-evaluates its WHERE against the committed
  row, sees `HELD`, and matches nothing. The status check alone handles
  simultaneity. What the version catches is the **stale read** — a plan
  computed before the unit was held and released by someone else. It is
  AVAILABLE again, so a status check waves it through. `mutation.test.ts` pins
  both results, including the negative one.

- *Why not two-phase commit?* The participants are a technician's phone and a
  workshop's dispatcher, and 2PC requires every participant to hold a prepared
  transaction open until the coordinator decides. A phone cannot. So legs are
  acquired one at a time and undone backwards, and the price is a real window
  where some are committed and others are not — which is what `recoverSagas`
  exists to clean up.

- *A technician accepted and then the workshop declined. What do they see?* A
  distinct event, `TECHNICIAN_RELEASED_AFTER_ACCEPT`, not the generic
  withdrawal — they have already started driving, and being left holding an
  assignment that silently evaporated is the worst outcome the system can
  produce.

- *What stops re-dispatch thrashing?* Four things, and the interesting one is
  the third: debounce by zone (ten triggers in 32ms produce one solver run,
  measured); a reassignment cap counted from the durable record so it survives
  a restart; **a re-solve producing the same assignment raises nothing**; and
  every solve recorded with its trigger, so `SELECT trigger, count(*) FROM
  solver_runs GROUP BY trigger` answers "what is making this system re-plan?"

- *You found a job could become permanently undispatchable. How?* The SLA filter
  was evaluated against `now`, and the deadline is a function of the clock — so
  once a window closed, every option for that job was rejected forever. It
  stopped appearing in any plan and nothing said so; its only trace was a
  rejection code identical to the ordinary case of one van being too far away.
  The evaluation harness found it because most unserved jobs in a busy scenario
  had that shape.

- *How do you know the harness measures your real dispatcher?*
  `evaluation/policies/global.ts` is thirty lines and calls `solve()`. A test
  asserts the imports exist, and there is no cost function, feasibility filter
  or assignment algorithm anywhere under `/evaluation`.

- *You have a green suite. How do you know the tests are worth anything?* A
  passing test is not evidence; the check is whether removing the production
  behaviour turns it red. Four times now that check has failed and been fixed:
  a Phase 3 safety test that could not fail, a Phase 7 ordering decision no test
  could distinguish from its opposite, a Phase 8 comparator that survived being
  replaced by a weighted sum, and a Phase 11 version check whose test was aimed
  at the wrong clause.

- *Where is the AI, and what happens when it is gone?* At intake and in chat,
  both edges, both behind a confirm-or-correct screen. With it gone the driver
  answers the same structured picker the system has had since Phase 3,
  `GET /health` reports the extractor DEGRADED, and no dispatch decision
  changes — invariant 10 forbids an external call anywhere the solver can see.
  Proven with a real invalid key: one attempt, a 401, no retry, straight to the
  picker.

- *How do you know the model is worth its network dependency?* `npm run
  eval:ai` runs 108 hand-labelled Hindi/English breakdown descriptions through
  the real path against a ninety-line keyword control. Measured: top-1 68.5%
  against 59.3%, top-2 79.6% against 76.9%, schema-valid 99.1%, fallback 0%.
  It is a real improvement and not a transformative one, and it made the
  pipeline slightly WORSE calibrated (ECE 0.152 against 0.136).

- *Did a measurement ever change a decision?* Yes, and against the design. The
  correlation between hypothesis entropy and whether the dispatched capability
  set would have covered the true fault is 0.156 on the model — weak. The
  report prints "treat the entropy-driven hedging as unproven rather than
  validated", because it is written to print whichever way the number falls.

- *What does CRITICAL mean in your system?* Not a crash. The queue is still on
  screen, assignments are made by hand, and every write is still audited. It is
  reached by exactly one component — the solver queue being unreachable — and
  it recovers on its own within one fifteen-second probe cycle once the queue
  is back.

- *Your planner is O(n³). What happens when it does not finish?* It is given a
  deadline and checks it BEFORE candidate generation, because generation is the
  routing call and a check after it saves nothing. Jobs it never reached keep
  the assignment they had, the run is stored with `timed_out = true`, and the
  ladder shows the planner DEGRADED. Measured under the forced switch: 96
  options in 1.9s against 11,280 in 11s.

## 15. Things An Interviewer Can Attack

The most valuable section. In rough order of severity:

1. **Seven of the eight re-solve triggers have no production caller.** Only
   `DIAGNOSIS_CHANGED` is wired. Technician decline and offline, and driver
   movement, wait on Phase 15; safety changes on 15b; cancellation on 15c;
   destination decline on 22. **`UNIT_BREAKDOWN` has no owning phase at all** —
   nothing in the build plan builds an event source for a van breaking down.
2. **`Job.safetyLevel` is never updated after intake.** The lexicographic
   safety ordering — invariant 4, the thing that sits *above* the cost function
   — operates on a value decided from a phone call that can no longer change.
   That is a bigger hole than any missing trigger.
3. **Zone partitioning demonstrably loses quality**, measured: 11 of 180 jobs at
   monsoon-surge, 6 of 60 at ambiguous-diagnosis. Worse, partitioning is by the
   job's stored `zoneId`, not by geography.
4. **Every number in the model is invented.** Twenty-four durations, two
   escalation constants, fifteen weights, fuel and labour rates, the 4x
   carriageway ratio, 45-minute service assumption, 250m material move, a
   reassignment cap of 3, 0.65 bits, 0.8 coverage mass. None fitted to data.
5. **A job whose window is open but unreachable by everyone still waits.**
   Feasibility is per-option and cannot see "all of them miss", so nothing is
   dispatched until the deadline passes and the filter relaxes.
6. **No idempotency keys on external-facing mutations**, against an explicit
   project convention, on a product whose normal client is a phone on a bad
   connection.
7. **Saga recovery's staleness window is a heuristic, not a lock.** Two
   processes restarting inside it both try to recover the same saga. The
   operations are idempotent so the outcome is correct, but the design rests on
   "probably nobody else owns this".
8. **Releasing the old crew is not transactional with starting the saga.** A
   crash between them leaves the job detached with no reservation started.
   Recoverable, but a real window.
9. **Accuracy numbers are self-referential.** The simulator generates symptoms
   from the same table the classifier inverts, and the harness draws its hidden
   true fault from the same distribution the solver sees — so the diagnosis is
   perfectly calibrated by construction, which flatters every belief-driven
   policy.
10. **Naive Bayes double-counts correlated evidence.**
11. **Unscoped reads and writes behind a role check** — intake writes with
    `prismaBase`, and `POST /solve` reads the whole fleet by design.
12. **No OSRM caching**, flagged at Phase 6 as "revisit at Phase 9" and still
    absent at 13.
13. **`buildDispatchSnapshot` silently drops jobs** with no location or
    hypothesis — neither planned nor reported. Invariant 8 says otherwise.
14. **A breach RECOMMEND can be ignored forever.** No ageing, no second
    escalation.
15. **The exactly-once pattern does not reach an external effect**, which
    Phase 15b's notifications will need.
16. **Bull Board grants unaudited operator power** — retry, discard and promote,
    none of it RBAC-checked or logged.
17. **`isBasementLevel` matches `/^b/i`**, tied to the simulator's format.
18. **The labelled AI set is hand-written by the person who wrote the prompt**
    (16). 108 descriptions, invented, labelled by their author. Read
    `top1Accuracy` as "can the pipeline recover a fault from a description that
    contains it", never as field accuracy. Replacing it with call transcripts
    is the single highest-value change available to that harness.
19. **The second-dispatch figure in the AI evaluation is a label-derived
    proxy** (16) — "would the capability set implied by this prediction have
    covered the labelled fault" — not an observed second callout. It cannot see
    a technician who arrived with the right skill and the wrong part.
20. **Only one of the two model providers has ever completed a call** (16).
    Everything measured came from Groq's `gpt-oss-120b`; the Anthropic path is
    typechecked and has returned a real 401, nothing more.
21. **Sending a chat message waits on a model call** (16) when a key is set,
    bounded by `LLM_TIMEOUT_MS`. It degrades to the rule table correctly, but
    it is latency on a path that had none. A queue is the right answer.
22. **The escalation race has no unique index behind it** (17). Two
    dispatchers deciding at once can produce two OPEN escalations for one job.
    The fix is a partial unique index Postgres supports and Prisma does not
    model.
23. **"Nearest feasible for unreached jobs" is not implemented** (17). The
    ladder's promise is narrower than the phase text: best incumbent and a
    flag. Computing a fallback assignment for an unreached job needs exactly
    the work the deadline just stopped.
24. **The manual dispatcher workflow is the existing console minus automatic
    re-planning** (17), not a purpose-built screen. It satisfies what CRITICAL
    promises — visible queue, audited writes — and it is not comfortable.
25. **The GPS probe is fleet-wide, not per-unit** (17). "Nothing has reported
    in fifteen minutes" cannot see one unit with a dead phone, and the
    job-level "last known position, flagged" behaviour the ladder describes is
    not something one component reading can express.
26. **`HUMANLY_CLEARABLE` is hand-ordered judgement** (17). It decides which
    refused option a dispatcher sees first and has never been checked against
    what dispatchers actually clear.
27. **No cost or rate-limit accounting on the model** (16). Nothing counts
    tokens or caps spend per driver; a retry-loop bug would be discovered on a
    bill.
28. **~45 of 84 tables have no reader.** Three pages have now been used in a
    browser (14–17), so the older blanket claim that none had is retired.
29. **Two whole-database test races hid in the money suites for two phases**,
    and only surfaced at Phase 17 when more test files widened the
    interleaving. The payout suite proved idempotency by counting what a
    GLOBAL run did (`again.paid`, then every row in a batch keyed by the day),
    so any suite booking earnings in parallel broke it for a reason unrelated
    to idempotency. Worse, `invariant8` and `money` each called the global
    authorisation-retry sweep, so whichever ran first authorised the other's
    pending payment and the loser asserted against a backlog somebody else had
    cleared. Both are the mistake `CLAUDE.md` already records from Phase 14,
    in a new shape: not a raw count this time, but a globally side-effecting
    FUNCTION shared by two suites. Fixed by scoping both — the assertions to
    the rows each file created, and `retryPendingAuthorisations` with an
    optional `jobIds` filter that production does not pass.

## 16. How I Would Improve It

In the order I would actually do it: wire the triggers that already have event
sources as Phases 15/15b/15c build them, and raise `UNIT_BREAKDOWN`'s missing
owner as a plan gap; make `safetyLevel` mutable with an audit trail, because
invariant 4 currently rests on a stale value; a solver-level fallback when a
job's only rejections are SLA ones; idempotency keys on the two external
mutations; a travel-time cache; and an owner column for saga recovery instead
of a staleness heuristic.

## 17. Defensible Resume Claims

Only what is implemented, and for numbers, only what was measured on this
machine:

- Built a **dispatch solver optimising expected time-to-resolution rather than
  time-to-arrival**: real road-network travel times, hard-constraint filtering
  with ten reason codes, a five-term cost function summing over a fault
  distribution including the cost of a likely re-dispatch, and a lexicographic
  safety ordering above it. Measured: a 7km broad-capability unit beats a 2km
  jump-start-only unit, 44.0 minutes against 48.5.
- Implemented the **Hungarian algorithm from scratch** for global assignment,
  verified against brute-force enumeration on 300 seeded matrices.
- Built a **deterministic evaluation harness** replaying five seeded scenarios
  through the production engine against four policies, reporting eight metrics
  and printing the scenarios where the proposed approach loses. Byte-identical
  stdout for a fixed seed. It quantified the cost of a scale approximation
  (zone partitioning: 11 of 180 jobs) and found a defect in which a job past
  its SLA window became permanently undispatchable.
- Implemented **optimistic-concurrency unit holds and a three-leg reservation
  saga** with compensations in reverse order and crash recovery, proved against
  a real Postgres started by the test suite: 50 concurrent holds on 10 units
  grant exactly 10, and a mutation test pins which clause protects which race.
- Built **re-dispatch with action tiering** — AUTO/RECOMMEND/APPROVE as a
  policy table — with thrash control measured end to end: ten triggers fired in
  32ms collapse to one solver run.
- Built **exactly-once queue processing** on at-least-once delivery, enforced by
  a Postgres unique constraint with the effect in the same transaction.
- Built an **entropy-driven intake** choosing each question by expected
  information gain: 0.00 questions for a stated flat tyre against 3.17 for an
  unexplained no-start.
- Implemented **three-layer read authorisation** failing closed on missing
  scope, with cross-tenant reads audited.

- Built an **LLM intake extractor and measured it against a control** rather
  than asserting it: 108 hand-labelled mixed Hindi/English breakdown
  descriptions through the production path, reporting top-1, top-2, expected
  calibration error, schema-valid rate, fallback rate and the correlation
  between hypothesis entropy and a wasted second dispatch. Measured 68.5% top-1
  against a keyword control's 59.3%, at 99.1% schema-valid with one retry
  recovering the only invalid reply. The same harness reported that the
  entropy-driven hedging it was meant to validate is **not** supported by the
  model's own numbers (r = 0.156).
- Designed the AI as a **degradable edge**: with the model unavailable the
  driver answers the structured picker, `/health` reports it, and no dispatch
  decision changes. Proven end to end with a deliberately invalid key.
- Built a **degradation ladder with eight chaos controls** — six components,
  three modes, persisted and re-probed every fifteen seconds, with every
  transition logged. Each control degrades visibly and recovers on its own
  within one probe cycle; the forced planner timeout cut a 470-job solve from
  11,280 options in 11s to 96 in 1.9s and flagged the run as incomplete.
- Turned **UNSERVICEABLE into a handover**: a card carrying the specific
  feasibility reason code, the closest option a human could actually clear
  (ranked by clearability, not distance), an alternative, a recommendation and
  three audited actions.
- Built a **double-entry ledger** for a marketplace's money — estimates,
  approvals with a re-approval tolerance, authorisation/capture, cash
  collection, commission and payouts — with a balance assertion that runs after
  every money test.

Not claimable: dispatch quality against real breakdowns, latency under load,
throughput, and anything about the Anthropic provider path beyond "it
compiles".

## 18. Technical Vocabulary

- **Time-to-resolution vs time-to-arrival** — resolution is when the fault is
  fixed. Zippy optimises the first.
- **Shannon entropy / expected information gain** — uncertainty in bits;
  non-negative in expectation, not per answer.
- **The assignment problem / Hungarian algorithm** — one column per row
  minimising total cost; solved in O(n³) with dual variables kept so every
  reduced cost stays non-negative.
- **Reduced cost** — `cost[i][j] - rowPotential[i] - colPotential[j]`.
- **Hard constraint vs soft cost** — a filter removes; a cost orders what
  survives.
- **Lexicographic ordering** — compare on one key first; safety sits above cost
  so it cannot be traded away.
- **Saga vs 2PC** — compensation instead of rollback, because external
  participants cannot hold a prepared transaction open.
- **Compensating transaction** — an action that semantically undoes a committed
  one; must be idempotent.
- **Optimistic locking / the ABA problem** — detect conflict with a version
  check; the version is what distinguishes "the row I decided on" from "a row
  that has been round the block".
- **READ COMMITTED** — Postgres's default; a blocked UPDATE re-evaluates its
  WHERE against the committed row.
- **TOCTOU** — why check-then-act loses to a constraint.
- **Discrete-event simulation** — advance to the next event, not the next tick.
- **Gini coefficient** — spread of a distribution, 0 even and 1 one taker.
- **Debounce / deduplication window** — collapse a burst of triggers for the
  same key into one run.
- **Action tiering** — AUTO / RECOMMEND / APPROVE as a policy table.
- **Dead-letter queue**, **capped exponential backoff**, **transactional
  outbox**, **fail-closed**, **MLD vs contraction hierarchies**.

## 19. Current Project State

**Phases 0–17 complete — the build plan's "core complete" marker.** 643 fast
tests across 45 files, plus the concurrency suite against a real Postgres
container. `tsc --noEmit` (src, tests, evaluation, prisma) and `eslint src
evaluation` clean.

Working, in the order it was built:

- **Foundation** — two processes, Zod-validated env, pino with request ids,
  real dependency health checks; 84 tables with append-only triggers; an
  idempotent seed of 6 zones, 24 units, 31 technicians with an uneven
  capability matrix.
- **Auth and tenancy** — JWT pair, argon2id, a permission table, tenant-scope
  and row-ownership Prisma extensions, audited cross-tenant reads.
- **Intake** — naive-Bayes classification, entropy-driven questioning with four
  stop conditions, safety triage, a deterministic simulator.
- **Realtime** — Socket.IO with handshake JWT, three room types, one fan-out
  point, transactional outbox, Redis adapter, per-job reconnect replay, and a
  polling fallback when the socket cannot connect.
- **Queues** — four BullMQ queues, capped backoff, dead-letter, idempotent
  processors, BullMQ-native debouncing, a repeatable cleanup sweep.
- **Routing** — self-hosted OSRM (MLD) with per-origin haversine fallback and a
  degraded flag.
- **The solver** — candidates, ten feasibility reason codes, a per-fault
  duration model, a five-term cost function, three weight vectors, a
  lexicographic safety comparator, a hand-written Hungarian assignment with
  zone partitioning, and a deadline that returns the best plan found.
- **The evaluation harness** — five scenarios, four policies, eight metrics, a
  sweep, and `EVALUATION.md`.
- **Holds, offers and the saga** — version-checked holds with TTL, technician
  offers with real expiry, a three-leg reservation saga with compensations,
  crash recovery at worker startup.
- **Re-dispatch and action tiers** — the trigger list in one place, thrash
  control, AUTO/RECOMMEND/APPROVE, on-site diagnosis, the action queue.
- **The dispatch console** — live timeline, the "why this technician?"
  inspector rendering the stored decision record, scarcity, three competing
  plan cards, the priority queue, a live map.
- **Driver and technician surfaces** — every sentence worded by the server, the
  technician's status ladder, offline queueing on the technician's phone.
- **Chat and event promotion** — a message becomes a FLAGGED proposal, never a
  job change; a human confirms, and who may confirm depends on the kind.
- **Money** — price lists pinned at creation, estimates with a re-approval
  tolerance, authorisation and capture, cash collection, commission, a
  double-entry ledger that is asserted to balance, payout batches, coverage
  caps with a covered/payable split.
- **GenAI intake** — free text in Hindi, English or both becomes a filled-in
  symptom form the driver confirms; two providers behind one boundary; every
  attempt stored; `npm run eval:ai` measures it against a keyword control.
- **Chaos and degradation** — a six-component ladder, a fifteen-second health
  loop, eight chaos controls absent from production builds, the escalation
  card, and `CHAOS_TESTING.md` written from a real walkthrough.

**Verified in a browser:** the driver's page — sign-in, free-text description,
the DEGRADED banner, the symptom picker, safety, location, job creation and the
live status panel. The dispatcher and technician pages have been exercised over
HTTP but not clicked through end to end.

**Not started:** parts and inventory (18), parts-aware feasibility (19), and
everything after.

**Known-stale data:** the development database carries ~460 INTAKE jobs left by
earlier phases, which compete with any new job for 24 units. A demo should run
against a fresh seed, or the queue should be aged first.
