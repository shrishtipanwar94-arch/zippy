# INTERVIEW.md

A living interview-prep document for the maintainer. It is maintained
automatically: one structured entry per phase goes into DECISIONS.log, and at
checkpoints (end of Phases 4, 9, 13, 17, 22) that log is consolidated in here
and cleared.

**State after Phase 22 (checkpoint — recommended ship point).** The thesis is
implemented, measured, surfaced and breakable on purpose, and the platform now
has a real inventory, a real tenancy layer and a real network of tow
destinations behind it. A job goes from free text (or a symptom picker) to
several ranked, globally assigned plans — up to four now that a contract-
protecting vector exists — through a pure engine that also resolves what part
a crew needs and where a tow goes, inside the same candidate-generation pass
that never grows the assignment matrix; a dispatcher turns one plan into a
real three-leg reservation; a technician who finds something different
triggers a re-solve; the work is priced, approved, paid, booked to a
double-entry ledger and paid out; and a contract tenant's jobs are priced,
scoped and arbitrated against consumer jobs for the same scarce van. Three
browser surfaces exist and have been used — driver, technician, dispatcher. An
LLM fills in the intake form and has been measured against a keyword control.
Every failure mode has a rung on a degradation ladder, a switch that forces it,
and a banner that names it.

What does not exist: the Razorpay adapter (22b) and anything after.

---

## 1. Project Overview

Zippy is a roadside breakdown dispatch system. The thesis: optimise expected
**time-to-resolution**, not time-to-arrival. The nearest technician often
cannot fix the fault — dispatching them is fast to arrive and slow to resolve,
because a second dispatch then has to happen.

**That objective function exists, and it has been measured against
alternatives rather than asserted.** `npm run eval` replays six seeded
scenarios through the production engine against four policies. On the baseline
scenario the inversion the project is built on shows up directly: `fifo` and
`nearest-unit` post the fastest arrival (~36 min) while
`capability-aware-global` resolves far more jobs (56/60 against 41–42) at a
slower arrival (53 min). On **ambiguous-diagnosis** global resolves fewer jobs
than nearest-unit and the report calls that a loss — see §15; `npm run
eval:sweep` shows the same weak point recurring under load.

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
    triggers**, **action tiers**, contract exposure, contract contention,
    the fleet-vehicle intake prior, the learned P(accept) formula
    (`workshopAcceptance.ts`) and workshop opening hours. No Prisma, no
    clock, no `Math.random`.
  - `src/engine/` — the solver. Candidates, feasibility, durations, cost,
    ranking, allocation, solve, **part sourcing** (19) and **destination
    selection** (22), both resolved inside candidate generation so the
    assignment matrix never grows past jobs × (unit, technician). **Zero
    imports from prisma or redis**, checked by a standing grep, and it
    writes nothing.
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
and — for tows, since Phase 22 — offers the workshop candidate generation
actually resolved (brand-authorised, EV-class-compatible, open, screened by
distance and the learned P(accept)). Any leg failing compensates the rest in
reverse. If the new plan does not use the crew already on site, they are
explicitly released at this point, not when the recommendation was raised.
Whatever a workshop answers — or does not, before the same deadline the
technician offer shares — becomes one more row the next solve's P(accept)
reads.

**Money** (Phase 15c) is not on the dispatch critical path by design: a price
list is pinned at intake, an estimate is raised and approved with a
re-approval tolerance, capture and cash collection both discharge the same
customer debt, and every movement posts to a double-entry ledger asserted to
balance after every money test. **Chat** (15b) never changes a job directly —
a flagged message becomes a proposal a human confirms. Both are implemented;
the Razorpay adapter behind the payment interface (22b) is not.

## 4. Database

**85 tables** (`grep -c '^model ' prisma/schema.prisma`), unchanged in count
since Phase 17 — Phases 18–22 added COLUMNS to existing Phase 1 tables far
more often than new tables (`unit_stock.starting_qty`,
`sla_policies.breach_penalty_paise`, `acceptance_outcomes.workshop_id` /
`.hour_bucket` / `.vehicle_class`, `dispatch_options.part_sourcing` /
`.destination`), because the schema was largely drawn at Phase 1 and later
phases gave its tables real readers and writers rather than new shapes.
Exercised through Phase 22: intake, auth, solver, commit, chat, money, AI,
health, parts, tenancy, fleet and the workshop network — most of the
remaining unread tables are the Razorpay-adapter ones (22b) and a few
genuinely speculative Phase 1 columns. See §15.28.

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
POST /vehicles                register a vehicle to one tenant, tenant off the token
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
18. **A cached aggregate with a reconciliation invariant** (18) —
    `unit_stock.quantity` is a running total of an append-only movement
    ledger, checked by `starting_qty + SUM(delta) = quantity`, the same shape
    as the double-entry balance check applied to counts instead of money.
19. **Dimensionality collapse inside candidate generation** (19, 22) — a
    genuine choice (which part source, which workshop) resolved to ONE answer
    per option before the assignment problem is built, so the matrix stays
    jobs × (unit, technician) regardless of how many real alternatives were
    considered. Parts collapse per PAIR (stock differs by van); destinations
    collapse per JOB (the answer does not depend on the crew at all) — the
    same technique, two different granularities, for a reason worth being
    able to state.
20. **A cost term as a CREDIT rather than a penalty** (20) — a contract
    breach is priced as what a dispatch AVOIDS, not what it risks, because
    the assignment prices an unserved job with one flat sentinel and the only
    way the cost of not serving it can enter the objective is as a discount
    on the cells that do serve it. Getting the sign backwards was caught
    before the code ran, designing the phase's own required test.
21. **Lexicographic ordering applied to a MATCHING, not a sort** (20) — safety
    solved as a SEQUENCE of assignment problems, most dangerous first, each
    band seeing only the units the band above left, rather than as a
    tie-break inside one comparator.
22. **A Beta-Bernoulli conjugate prior** (22) — `(priorAlpha + successes) /
    (priorAlpha + priorBeta + total)`. The textbook answer to "estimate a
    probability from counts without a training loop": cold start is exactly
    the prior with zero substituted for both counts, and a cell with a
    hundred outcomes moves less per new one than a cell with three, provably,
    from the same one-line formula.
23. **Reusing one belief-revision mechanism for two kinds of evidence** (21)
    — a fleet vehicle's own incident history is folded into its starting
    fault distribution through the SAME `applyLikelihood` Bayes update a
    symptom answer already goes through, rather than a second "how much does
    this move the belief" formula invented for history specifically.

## 8. Engineering Problems

**Solved and measured:**

- *How many questions should intake ask?* Entropy decides. `FLAT_TYRE` 0.00
  questions, `WONT_START` 3.17.
- *Why send the further unit?* Expected time to resolution sums over the whole
  fault distribution: 48.5 min for a near narrow crew against 44.0 for a
  further broad one.
- *Does global assignment actually beat greedy?* Measured across six
  scenarios. In five it resolves more jobs; it loses ambiguous-diagnosis on
  jobs served, and the harness prints that.
- *What does a scale approximation cost?* Zone partitioning splits the board
  above a candidate threshold so a job cannot be matched to a free unit in the
  next zone. The threshold sweep that used to quantify it is not in the
  current harness — unmeasured at this checkpoint, not zero.
- *How do two dispatchers not take one unit?* 50 concurrent holds on 10 units
  grant exactly 10, against a real Postgres in a container.
- *How do you stop a burst of triggers becoming a burst of solves?* Debounce by
  zone. Ten triggers in 32ms → one solver run.
- *Does giving a fleet vehicle its own history actually change intake?*
  Measured directly: a vehicle with two prior battery incidents and a stated
  "will not start" needed **zero** further questions (`CAPABILITY_SET_STABLE`
  fired immediately); the identical stated symptom on a vehicle with no
  history still needed one.
- *Does the learned P(accept) actually move, and does it change which
  workshop is picked?* `scripts/simulate-200-offers.js --decline-evenings`
  against a real workshop produced 5 accepted / 50 refused in the evening
  bucket at a 20% ground-truth rate; the `workshop_acceptance` view returned
  `p_accept = 0.2` exactly, matching `betaAcceptMean`'s own formula to the
  decimal. The ranking flip is proved directly in
  `tests/destinationSelection.test.ts`: an otherwise-nearer, unreliable
  workshop loses to a farther, reliable one once the acceptance-history gap
  is large enough to outweigh `REFUSAL_DISTANCE_PENALTY_KM`.

**Ahead:** the Razorpay adapter (22b).

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

**From Phases 18–22:**

- **A part declaration races a replenishment on the same shelf** (18). Two
  writers on `unit_stock.quantity`; a conditional UPDATE on the version read,
  re-read and retried up to three times. A double tap or an offline-queue
  replay races nothing — the movement id is client-minted and the primary
  key, so a duplicate insert fails on the constraint and the caller is told
  REPLAYED.
- **Two dispatchers solve at the same instant over the same last battery**
  (19). Not handled by the parts layer at all, deliberately — invariant 7
  (one active job per unit) means the loser of the saga's version-checked
  hold never reaches the shelf, so stock is not separately reserved.
- **A contract is edited while a technician is driving to a job priced under
  it** (20). Not handled by locking — `jobs.sla_policy_id` is pinned once at
  intake and never re-read, the same pattern `price_list_id` and
  `settlement_path` already use. Pinning the ID freezes WHICH policy applies,
  not that policy's own numbers; an in-place edit to an `sla_policies` row
  would still reach every live job that pinned it, and nothing in this
  system edits one in place today.
- **Two dispatchers, or a dispatcher and the debounced zone re-plan, raise a
  cross-tenant contention card for the same losing job at once** (20).
  Read-then-write, NOT atomic — `findFirst` for a PENDING card, then insert.
  Two identical cards is the worst case, and it is cosmetic (approving one
  executes nothing) rather than harmful. The honest fix is a partial unique
  index Prisma cannot model; §15 says so rather than the code claiming a
  guarantee it does not have.
- **A fleet manager notification fires for a tenant with two FLEET_MANAGER
  users** (21). `Promise.all` over per-recipient `notification.create`
  calls, each independently idempotent through one outer `runIdempotently`
  keyed on the queue job id — a crash mid-`Promise.all` and a redelivery
  both replay as a whole retry, unchanged by there being more than one
  recipient.
- **A workshop's answer and its saga's shared deadline fire at nearly the
  same instant** (22) — a human replies as the offer-expiry worker wakes.
  The same conditional-update shape as everything else: `WHERE id = ? AND
  status = 'PROPOSED'`. Whichever writer's UPDATE commits first wins;
  the loser's `updateMany` returns `count: 0` and records no
  `AcceptanceOutcome` — the guard is on the WRITE, not a prior read.
- **The same tow job is re-solved twice, an hour apart** (22). Not a bug to
  fix — the learned P(accept) and the workshop's opening hours are read
  FRESH on every solve, so the same job can genuinely be routed to a
  different workshop as the hour bucket or the acceptance history shifts.
  Handled by the saga machinery already in place: a destination change is
  exactly the `NO_CHANGE` vs `REASSIGNMENT_PROPOSED` branch `handleTrigger`
  already has.

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
- **"We did not look" and "we looked and found nothing" are different states,
  never conflated** (19, 22). `PartsSnapshot`/`WorkshopsSnapshot` absent means
  NOT_MODELLED and never rejects; UNVERIFIED stock or no authorised workshop
  is a real, fail-CLOSED rejection. The two failure directions are not
  symmetric: assuming a part or a destination exists when it does not sends a
  crew who arrives to nothing, which is worse than the conservative miss.
- **A degraded read never blocks dispatch, only prices it worse** (20, 21).
  A job with no pinned SLA policy, no learned P(accept) history, or no
  destination screening simply carries a neutral value (no exposure, the
  prior probability, "not needed") rather than failing the request — the
  same "payment failure never blocks dispatch" principle applied to three
  more inputs.

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

**Parts and inventory (18).** `unit_stock.quantity` is a CACHE of an
append-only movement ledger, anchored by `starting_qty` so
`starting_qty + SUM(delta) = quantity` is checkable rather than trusted —
Phase 19 needs that number inside candidate generation, per option, and a
derived-on-read sum would be too slow to ask that often. Consumption does NOT
refresh `confirmed_at`: fitting a belt is not counting the belts, and
refreshing it would let a busy van read VERIFIED without anybody having
looked. A count that disagrees writes an ADJUSTED movement, never an
overwrite — the ledger keeps explaining the number. No cross-van part
transfer: the phase names it as a cliff (a second unit's version, a custody
state while the part is in neither van, a rendezvous the solver would have
to price), and Phase 19 prices a workshop run instead — one leg, one owner.

**Part-aware feasibility (19).** `canResolve(option, fault) = hasSkill ∧
hasPart`, resolved inside candidate generation and collapsed to ONE
`PartSourcing` per (unit, technician) pair — the assignment matrix stays jobs
× units regardless of how many ways a part could be sourced, asserted by an
`option count` test. UNVERIFIED stock counts as absent: believing a part is
there when it may not be sends a crew who opens an empty shelf and leaves,
which is worse than a detour that turns out to be unnecessary — the two
mistakes are not symmetric, and invariant 3 keeps that asymmetry a FILTER
rather than a cost a big enough SLA pressure could eventually outvote. A
detour past `MAX_PART_SOURCING_DETOUR_MINUTES` (45) is a rejection, not an
expensive option, for the same reason: a threshold long enough to make a
two-hour detour reliably lose is a threshold acting as a constraint. The
evaluation harness's three greedy baselines are deliberately stock-BLIND —
handing them an inventory model an incumbent nearest-unit dispatcher does not
have would rig `stockoutInducedFailures` in the parts layer's favour, and the
metric would then measure nothing.

**Tenancy and contracts (20).** A contract breach enters the cost function as
a CREDIT — `-(1 - P(breach)) × penalty`, what the dispatch AVOIDS — never as
a positive cost, because the assignment prices an unserved job with one flat
sentinel identical for every job; pricing exposure as a positive cost on the
served cell would make a GOLD job the EXPENSIVE one and hand the last van to
a walk-in while the contract breaches. Safety became a lexicographic ordering
in the GLOBAL assignment, not only inside one job's ranking — the assignment
is now solved once PER SAFETY BAND, most dangerous first, because a
₹2,500 penalty is the first term in the cost function large enough to have
exploited the gap invariant 4 always had at the plan level. Cross-tenant
contention ESCALATES rather than resolving: at the same safety level the
objective will always prefer the priced obligation, and a system that
silently chooses which paying customer to disappoint is a system nobody
deploys. `PROTECT_CONTRACTS` changes exactly one weight from `BALANCED` — the
contract-exposure weight, ×10 — so the two plan cards differ in exactly the
question a dispatcher is actually being asked.

**The fleet-vehicle intake prior (21).** A fleet vehicle's own incident
history sharpens its intake prior through the SAME `applyLikelihood`
mechanism a symptom answer already goes through, capped at the five most
recent incidents — measured directly: two prior battery incidents plus an
identical stated symptom needs zero further questions where a stranger's
identical vehicle needs one. Reusing the Bayes update rather than writing a
second one is the decision: history is just another observation about the
same distribution, so a separate code path would have been a second thing to
keep correct for no new capability.

Phase 21 also built a fleet manager's dashboard — SLA met % as a four-state
answer per incident, current exposure, spend, per-vehicle history and a
repeat-pattern flag. **That surface has since been cut**, on the build plan's
own "if you fall behind" instruction to keep the tenancy in the engine and
drop the UI. What survives is everything the engine needed: the intake prior
above, contract exposure in the cost function, cross-tenant contention, and
per-tenant row scoping. `src/domain/repeatPattern.ts` survives as a tested
rule with no caller — see §15.35.

**Workshop network (22).** Destination selection resolves ONCE PER JOB, not
once per pair the way parts sourcing does — a workshop choice depends on the
vehicle, the location and the hour, none of which change with which crew is
sent, so recomputing it per pair would answer the identical question
repeatedly for nothing. Brand authorisation and EV class are separate
reason codes (an eleventh added to the ten named at Phase 7), because
"authorised for Maruti but not for EVs" is a distinct, actionable failure a
dispatcher needs to be able to tell apart from a manufacturer exclusion.
P(accept) is a Beta-Bernoulli conjugate prior — a counter and a formula, no
training loop, cold start exactly the prior with zero counts substituted —
and `destinationRefusalRisk` prices a refusal in MINUTES, not paise, because
a refusal is fundamentally a delay event and reuses `escalationMinutes`'s own
re-dispatch constants rather than inventing a new estimate. `startSaga`'s
`workshopId` parameter, real since Phase 12, is threaded from the solved
option's own `destination.workshopId` — the first production caller it has
ever had.

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

- *Your evaluation says the global policy loses a scenario. Why ship it?*
  It loses exactly one on the baseline grid — **ambiguous-diagnosis**, on jobs
  served: 19/60 against nearest-unit's 22/60. Its mean resolution there is 42
  minutes faster and its first-visit rate 22 points higher; it loses because it
  strands more (39 against 28) while chasing a crew who can cover the fault, and
  the harness scores that scenario on throughput. `npm run eval:sweep` re-runs
  the whole grid under six perturbations and the same weak point recurs at
  volume ×2 and OBD-scarce — ambiguous-diagnosis is the scenario with the least
  diagnostic signal, so belief-driven dispatch has the least to work with
  there. Every mean in the table is over jobs that finished, so read `resolved`
  first: a policy that strands the hard jobs posts a flattering mean.

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
  the real path against a 72-line keyword control. Measured: top-1 68.5%
  against 59.3%, top-2 79.6% against 76.9%, schema-valid 99.1%, fallback 0%.
  It is a real improvement and not a transformative one, and it made the
  pipeline slightly WORSE calibrated (ECE 0.152 against 0.136).

- *Did a measurement ever change a decision?* Yes, and against the design. The
  correlation between hypothesis entropy and whether the dispatched capability
  set would have covered the true fault is 0.156 on the model — weak. The
  report prints "treat the entropy-driven hedging as unproven rather than
  validated", because it is written to print whichever way the number falls.

- *What does CRITICAL mean in your system?* Not a crash. The priority queue is
  still on screen, ordered as always, and every write is still audited — what
  stops is automatic RE-PLANNING. It is reached by exactly one component, the
  solver queue being unreachable, and it recovers on its own within one
  fifteen-second probe cycle once the queue is back. The banner said
  "assignments are made by hand" until Phase 22b; that screen was cut at
  Phase 9 and the sentence was corrected rather than the workflow rebuilt (§15).

- *Your planner is O(n³). What happens when it does not finish?* It is given a
  deadline and checks it BEFORE candidate generation, because generation is the
  routing call and a check after it saves nothing. Jobs it never reached keep
  the assignment they had, the run is stored with `timed_out = true`, and the
  ladder shows the planner DEGRADED. Measured under the forced switch: 96
  options in 1.9s against 11,280 in 11s.

- *You added parts to a dispatch problem — why didn't the assignment matrix
  explode?* Because the choice of part source is resolved per (unit,
  technician) pair inside `generateCandidates` and collapsed to the single
  best one, so parts made every option richer and the matrix exactly the
  same size — `tests/candidates.test.ts`'s `option count` block asserts it.

- *Your evaluation predicted skill-aware would beat nearest on stockouts and
  it didn't. What happened?* A stockout-induced failure is defined as a crew
  who had the SKILL and not the part, so maximising skill coverage moves
  failures INTO that column that a nearest-unit policy books as capability
  failures instead — the metric separates two kinds of wasted visit rather
  than ranking parts-awareness, and `EVALUATION.md` finding 4 says so with
  the numbers.

- *You put a contract penalty in the cost function. Which way does the sign
  go, and why?* Negative — the term is what the dispatch AVOIDS, not what it
  risks, because the assignment prices an unserved job with one flat
  sentinel and the only way the penalty for going unserved can enter is as a
  credit on the served cells. Priced the other way round, a GOLD job becomes
  the expensive job and the last van goes to the consumer while the contract
  breaches.

- *Safety outranks contract tier — where is that actually enforced?* In two
  places for two different questions: `ranking.ts` for which crew goes to
  one job, and safety BANDS in `buildPlan` for which job gets the last van.
  The second arrived at Phase 20, because a hundred-point contract term was
  the first thing in the cost function large enough to have exploited the
  gap.

- *Why does a fleet vehicle's prior use the same `applyLikelihood` function a
  symptom answer does, instead of its own weighting formula?* Because the
  two are the same operation under a different name — "how much should this
  observation move the belief" — and reusing the tested, entropy-checkable
  mechanism means the prior's effect on question count is provable by the
  exact same maths that already governs when intake stops asking, rather
  than a second formula nobody has separately verified.

- *Where's your ML, in the workshop layer?* There isn't any, on purpose.
  `betaAcceptMean` is `(priorAlpha + accepted) / (priorAlpha + priorBeta +
  total)` — Bayes' rule for a Beta prior over a Bernoulli outcome, derivable
  on a whiteboard. Cold start is exactly the prior with zero substituted for
  both counts, and a workshop with a hundred outcomes moves less per new one
  than a workshop with three, provably, from that one formula and nothing
  else.

- *You added a whole third dimension — where a tow goes — to the assignment.
  Why didn't the matrix grow?* Because unlike parts, the destination choice
  does not depend on which crew is chosen at all — it is resolved once
  against the JOB before the per-pair loop even starts, and every option for
  that job reads the same value. There is no "option count" test the way
  Phase 19 needed one, because there was never a second dimension to
  collapse in the first place.

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
3. **Zone partitioning is a scale approximation on top of the objective.** Above
   the candidate-count threshold `allocation.ts` splits the board by the job's
   stored `zoneId` — not by geography — and solves each zone separately, so a
   job in a busy zone cannot be matched to a free unit next door. An earlier
   harness quantified the cost with a partitioned-vs-whole-fleet threshold
   sweep; that experiment is not in the current `eval:sweep` (a robustness grid
   now), so the figure is unmeasured at this checkpoint rather than zero.
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
28. **~40 of 85 tables have no reader.** Three pages have now been used in a
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
30. **A depot has infinite stock** (18–19). `measureDepotRuns` never asks
    whether the depot actually has the part — Phase 18 made depots
    deliberately dumb and Phase 19 builds a real dispatch decision on that.
    Fine at three depots in one city; "the workshop run always succeeds" is
    the single most optimistic assumption in the whole parts layer.
31. **Part value is priced off the STANDARD price list, not the job's own
    pinned list** (19). Deliberate — this is a dispatch input, not a bill —
    but it means a tenant with a custom price list is dispatched against
    somebody else's prices.
32. **`TENANT_CONTRACT_EXCLUDES` is still a stub** (20), the one reason code
    of eleven that has never fired. The obvious trigger — a service a
    contract does not cover — is already handled correctly by
    `settlementPathFor` turning the driver into a WALK_IN; turning coverage
    into a hard FILTER would refuse to help a stranded person over a billing
    question, the same mistake the SLA filter had to be talked out of at
    Phase 10.
33. **The cross-tenant contention guard is read-then-write, not atomic**
    (20). Two concurrent solves can raise two identical APPROVE cards for
    one contested unit. Cosmetic — approving one executes nothing — and the
    honest fix (a partial unique index on `(job_id, kind) WHERE status =
    'PENDING'`) is not built.
34. **A capped contract's uncovered remainder is booked to the wrong ledger
    account** (15c) — it posts to the generic customer receivable rather than
    the `tenant:<id>` account. Phase 21's dashboard used to sidestep this by
    reading the approved estimate total directly instead of the ledger, and
    that dashboard has since been cut; cutting it removed the symptom and not
    the bug, which is still here and still unfixed.
35. **The repeat-pattern rule and the intake prior both match on the EXACT
    fault code**, never a category (21) — `FLAT_BATTERY` and
    `FAILED_BATTERY` never combine into one pattern even though both are "the
    battery" to anyone reading them. Neither has any recency WEIGHTING
    either, only a recency CAP: a five-day-old incident and a
    fifty-nine-day-old one count exactly the same.

    The intake prior is live. **The repeat-pattern rule has no production
    caller at all** — the fleet dashboard was the only thing that rendered the
    flag, and cutting that surface left the rule behind, still unit-tested and
    still correct but dead until something reads it. Kept rather than deleted
    because the rule is sound and where it belongs — most likely the
    dispatcher's job inspector — is a separate decision.
36. **`REFUSAL_DISTANCE_PENALTY_KM` (22) is the single most consequential
    unmeasured number in the workshop layer.** It sets the exchange rate
    between "closer" and "more likely to accept a tow", and nothing has ever
    measured what a real dispatcher would actually trade one for.
37. **The learned P(accept) has no decay** (22) — a workshop's refusal from
    eight months ago counts exactly as much as one from yesterday, the same
    gap the intake prior has for a vehicle's own history (§15.35), now in a
    second place.
38. **Cold start is silent** (22). A brand-new workshop with zero real
    outcomes reads exactly the prior (0.8) with no signal anywhere —
    dashboard or `screened` row — distinguishing "eighty real outcomes said
    yes 80% of the time" from "nobody has ever answered".
39. **The chaos panel's forced destination decline teaches the learned
    probability nothing** (22). `declineDestination` updates the offer row
    directly, the same way every chaos action does, so the one control that
    can force a refusal on demand does not feed the mechanism a refusal is
    supposed to train.
40. **`generateCandidates` now defaults `now` to the wall clock** (22),
    mirroring the existing `travelTimes` default — correct for production,
    and it means a caller that forgets to pass its own `now` for a
    deterministic test gets today's date silently rather than an error. The
    same trade-off `travelTimeMatrix`'s own default already accepted,
    extended to a second non-deterministic input.
41. **THE CONSOLE PLANS AND AUDITS; ONLY THE ACTION QUEUE COMMITS — and nobody
    decided that.** This is the largest gap in the product and it was found by
    walking it, not by reading it: a job was created, solved, and a plan taken,
    and no technician was ever offered anything.

    Trace both halves. `POST /solve` (`api/solve.ts`) runs the engine and calls
    `persistSolverRun`, which writes `solver_runs`, `dispatch_options` and
    `plan_variants` and nothing else. `POST /plans/:id/select`
    (`console.ts:517` → `decisionRecords.ts:50`) writes one `decision_records`
    row and one `PLAN_SELECTED`/`PLAN_OVERRIDDEN` event per assignment, in one
    transaction, and stops — it imports neither `saga.ts` nor `offers.ts`. The
    queued worker (`workers/solver.ts`) makes exactly the same audit-only
    writes. Neither path holds a unit, sends an offer, or changes a job row.

    There is one door into the reservation saga and it is narrow:
    `POST /actions/:id/execute` → `executeReassignment` (`redispatch.ts:284`) →
    `startSaga` → `proposeOffer` → `commitSaga`. It is gated at `actions.ts:91`
    to two action kinds, both `REASSIGN_*`. `commitSaga` (`saga.ts:262`) is the
    only place in the codebase that ever sets `assignedUnitId`. So a plan can
    only become a dispatch by way of a re-plan trigger — a technician filing a
    different diagnosis, or a driver's message being confirmed — and pressing
    Solve contributes nothing to it.

    **It is a wiring gap, not a design.** Nothing anywhere records a decision
    that a dispatcher must not commit directly, and four pieces of evidence say
    it was scheduled and missed. `api/solve.ts:10` still reads "Holds are Phase
    11 and the reservation saga is Phase 12. *Until they exist*, choosing a
    plan is something a dispatcher does with their eyes";
    `persistSolverRun.ts:25` says the same thing in the same tense. Both phases
    shipped. `BUILD_PHASES.md:929`, the Phase 9 DO NOT list, says "no
    reservations **yet**" — Phase 12 then built the saga without ever
    specifying what triggers it, and Phase 13 wired the single trigger that
    phase happened to need.

    THE SCHEMA CARRIED THE SHAPE OF THE INTENDED PATH, as dead statuses. Five
    `JobStatus` values had no writer anywhere: `OFFERED`, `UNSERVICEABLE`,
    `AWAITING_DESTINATION` and `TOWING`, plus `PLANNED`, which was written only
    by a compensation (`saga.ts`) and by releasing a crew on re-plan
    (`redispatch.ts`) — never on the way forward. Every one of them has
    finished driver copy in `domain/driverNarrative.ts`: "We have asked a
    technician to come. Waiting for them to confirm", "Confirming a workshop
    that can take your car", "Your car is on its way to the workshop". Written,
    reviewed, unreachable. Dead copy is the cheapest possible evidence that a
    path was specified and never built, and it sat through four checkpoints
    because reading the code from the top never takes you past the point where
    it stops.

    **THE THREE GAPS ARE NOT THE SAME SIZE, and conflating them is the mistake
    to avoid when talking about this.**

    `OFFERED` **was one line, and it is now written.** `startSaga` sets it when
    leg 2 goes out, conditionally on the two statuses a job can legitimately be
    offered from. It closed a defect a customer could see: while a van was held
    and a named technician's phone counted down forty-five seconds, the driver's
    screen read "Finding someone equipped for this", because that is what the
    narrative returns for a job still marked INTAKE. `AWAITING_DESTINATION` is
    written in the same place for the same reason, and is unreachable for a
    different one — see §15.44.

    **The commit path is one call from closed.** Every piece the missing step
    needs exists and is tested: the saga has compensations and a recovery
    routine, offers expire, holds are version-checked, twelve concurrency tests
    run against a real Postgres. What is missing is deciding whether taking a
    plan should reserve a crew directly, or should raise a RECOMMEND per
    assignment — which is the shape every other decision in this system already
    has. That is a product decision, not a refactor, and it is the honest reason
    it is still open. Until it is made, the console says so on screen
    (`panels/plans.js`) and its button reads "Record this decision".

    **The tow path is not one call from anything** — it needs a counterparty
    that was never specified. §15.44.

42. **A real coordinate 1,742km away was accepted, filed into a Bengaluru zone,
    and routed against a Bengaluru road graph — by three layers each doing
    something defensible.** A driver in Delhi pressed "use my current location".
    Their browser returned a genuine fix, `accuracy_metres 149`, at
    28.696/77.207.

    `resolveZoneId` (`intake/createJob.ts`) asked `nearestZone` which zone was
    closest and took the answer. `nearestZone` is a nearest-neighbour function
    and had no opinion about distance, correctly — it was the caller treating
    "closest" as "contains" that was wrong. So the job was filed into
    `zone-heb`, 1,742km from the vehicle, and queued looking exactly like
    something a van could be sent to.

    Then OSRM snapped the off-graph coordinate onto the nearest node in its
    Bengaluru extract and returned a five-minute drive. The routing layer had no
    way to say "that is not on my map", so the travel estimate was not merely
    wrong, it was *plausible* — which is why only one of twenty-four options was
    rejected on SLA rather than all of them. Finally the console's live map,
    which fits its view to its markers, framed a 1,762km bounding box and
    centred on farmland in Maharashtra: the one component that behaved
    perfectly, and the only one that made the problem visible.

    Nothing had ever tested the assumption because every previous coordinate in
    the product's life came from `src/sim`, which only generates Bengaluru. The
    fix is a bound at the input (`SERVICE_AREA_RADIUS_KM`, 80km, with a driver-
    readable refusal); teaching the router to distrust its own answers would be
    the wrong layer. The lesson is the interesting part: three components each
    accommodated an impossible input rather than rejecting it, and the failure
    only became legible at the fourth, which was drawing a picture.

43. **A re-solve that found nobody used to leave no trace anywhere.**
    `handleTrigger`'s no-option branch returned `{ outcome: 'NO_OPTION' }` and
    wrote no action, no job event and no log line. The escalation card Phase 17
    specifies — reason, feasibility code, closest option, alternative,
    recommendation, three decisions — already existed and was already good, and
    was reachable only by clicking a job that nothing invited anybody to click.
    So the system correctly established that every van in the fleet was off
    shift and the finding went nowhere: an evening was spent concluding the
    dispatch path was broken. That is invariant 8 failing on the one path where
    the system has the most to say. Now fixed — `ESCALATE_NO_FEASIBLE_PLAN`
    carries the rejection breakdown (`NO_TECHNICIAN_ON_SHIFT x23,
    SLA_UNREACHABLE x1`) onto the worklist and a `NO_FEASIBLE_PLAN` event onto
    the timeline — but the shape of the bug is worth keeping: **a correct
    decision that nobody can see is indistinguishable from a broken one**, and
    every one of the eight rejection codes was already being computed, stored
    and thrown away at the last step.

44. **ZIPPY MODELS WORKSHOPS AS DESTINATIONS IT REASONS ABOUT, NOT AS
    PARTICIPANTS — and the saga's third leg needs a participant.** This is the
    largest of the three gaps in §15.41 and the only one that is not a wiring
    job.

    Everything on the reasoning side is real and works. `WorkshopAuthorisation`
    per brand with an EV class flag, `WorkshopHours`, a shortlist screened by
    authorisation and opening hours, a learned P(accept) from a Beta-Bernoulli
    prior over `AcceptanceOutcome`, `destinationRefusalRisk` as a term in the
    cost function, `DESTINATION_NOT_AUTHORISED` and
    `DESTINATION_EV_CLASS_MISMATCH` as separate feasibility codes, and a
    screening panel in the inspector. Phase 22's spec asks for exactly that and
    it is all there.

    What Phase 22's spec never mentions is a job status, and it never mentions
    an actor. **There is no WORKSHOP role** — the enum is DRIVER, TECHNICIAN,
    DISPATCHER, FLEET_MANAGER. **No route anywhere accepts a destination
    decision.** `recordDestinationDecision` exists, is correct, and is called by
    nothing but `tests/saga.test.ts`. So leg 3 is created at PROPOSED, and the
    only thing that can ever move it is the offer-expiry worker, which times it
    out at the same forty-five second deadline the technician offer uses —
    after which `advanceSaga` compensates the entire reservation.

    **From the roadside that was worse than not dispatching at all.** A
    technician accepts a tow; forty-five seconds later they are released by a
    timeout on a leg they could not have influenced, and their phone shows the
    Phase 13 release notice saying a re-plan took the job away. It did not.
    Nothing took it, and nothing could ever have completed it. So
    `executeReassignment` now refuses to start a saga whose plan names a
    workshop, before the current crew is released, and raises the same
    `ESCALATE_NO_FEASIBLE_PLAN` card a no-crew re-solve raises. Failing closed
    is not a fix — tows remain undispatchable — but a refusal an operator can
    read beats a dispatch that unwinds itself.

    `TOWING` is a second, separable piece of the same gap and is worth naming
    on its own: the technician's ladder (`domain/jobLadder.ts`) is
    `COMMITTED → EN_ROUTE → ON_SITE → DIAGNOSING → WORKING → RESOLVED`, and its
    own comment lists "awaiting a workshop" as off the ladder. There is no tow
    rung. A technician towing a car today would press the same five buttons as
    one changing a tyre. `TOWING` appears nowhere in `BUILD_PHASES.md` at all —
    not cut, not deferred, never written down.

    **QUALIFY THE LEARNED P(accept) ACCORDINGLY, because this is where a
    resume claim would overreach.** The estimator is built, the formula is a
    conjugate prior rather than a model, and it demonstrably moves — §8 records
    the measurement: 5 accepted / 50 refused in the evening bucket at a 20%
    ground-truth rate produced `p_accept = 0.2` exactly. But that measurement
    came from `scripts/simulate-200-offers.js`, which fabricates outcomes
    directly. **No workshop has ever accepted or refused anything in this
    system, because none can.** In a running instance `acceptance_outcomes` is
    empty and every workshop is scored on the cold-start prior, which means
    `destinationRefusalRisk` currently contributes the same constant to every
    destination and ranks nothing. The demo prep runs that script against one
    seeded workshop so the mechanism is visible and the evening effect is real;
    the other eleven remain on the prior. The correct claim is "built a learned
    acceptance model and verified it against fabricated ground truth", never
    "learned from operational data".

    The size of it, plainly: a workshop has to become something that can be
    asked and can answer — a role and a surface, or a webhook and an adapter,
    or a dispatcher confirming by phone on the workshop's behalf, which is what
    most operators would actually do on day one. Then a tow rung on the ladder.
    Then the statuses light up on their own, because `startSaga` already writes
    `AWAITING_DESTINATION` and is waiting for something to answer it.

45. **THE MOST DANGEROUS JOBS WERE THE ONLY ONES THAT COULD NEVER BE
    DISPATCHED — and the bug was invisible from every angle except walking the
    driver surface end to end.** Fixed.

    Chain four true statements together and the fifth falls out. Reserving a
    crew happens in exactly one place: executing a reassignment action
    (`commit/redispatch.ts`'s `executeReassignment`). Selecting a plan only
    records a decision, which is §15.41's open product question. The only thing
    a *driver* can do that raises such an action is confirm a safety
    escalation. And `applySafetyChange` (`commit/eventPromotions.ts`) returned
    `trigger: null` when the level could not go any higher, on the reasonable
    grounds that nothing had changed.

    So a job triaged `HIGH_RISK` at intake had its one escalation spent before
    it started. The driver pressed **Yes** on "Are you blocking moving
    traffic?", a `SAFETY_LEVEL_CONFIRMED` event landed on the timeline, and
    nothing else happened — no trigger, no re-solve, no action card, no crew,
    ever. Alone, at night, on a highway is exactly the combination that triages
    straight to `HIGH_RISK` (`ON_HIGHWAY`, `NIGHT_AND_ALONE`,
    `ALONE_AT_NIGHT_ON_HIGHWAY`), so the property was: **the more dangerous
    your breakdown, the less likely the system could ever send anybody.**

    Every unit test passed throughout. Each of the four statements is correct
    on its own and each is separately tested; the defect was in the composition
    and only a walk through the real driver surface surfaced it. The two event
    trails side by side are the whole story — same flow, different starting
    safety level:

        started NORMAL                    started HIGH_RISK
        6 SAFETY_LEVEL_CHANGED            7 SAFETY_LEVEL_CONFIRMED
        7 ACTION_RECOMMEND                  (ends here)
        8 ACTION_EXECUTED
        9 UNIT_HELD
       10 TECHNICIAN_OFFER_SENT
       11 TECHNICIAN_OFFER_ACCEPTED
       12 DISPATCH_COMMITTED

    THE FIX IS A NINTH REPLAN TRIGGER, `SAFETY_LEVEL_CONFIRMED`
    (`domain/replanTriggers.ts`), returned by that branch when the job has no
    `assignedTechnicianId`. Deliberately NOT reusing `SAFETY_LEVEL_CHANGED`:
    the level genuinely did not move and an event claiming otherwise is a lie
    in a timeline whose whole value is that it is not. Gated on there being no
    crew, so a driver repeating themselves while somebody is driving to them
    does not re-solve the board on every message. Both halves are tested in
    `tests/eventPromotion.test.ts`.

    WHAT IT DOES NOT FIX, and this is the honest part: the underlying shape is
    still §15.41. A safety confirmation is now a *second* route to a crew where
    there had been one, but the routes are still incidental — dispatch is
    reachable only as a side effect of something going wrong, never as a
    dispatcher simply deciding to send a van. That decision is the one still
    unmade.

46. **TWO CONTROLS THAT WERE DELIBERATELY INERT AND SAID NOTHING.** Both fixed,
    and they share a lesson worth stating once: a control that is correctly
    disabled and silent about it is indistinguishable from broken software, and
    the person who concludes the software is broken is right to.

    **"Send for help" on the driver's location screen.** Disabled until a road
    position is picked — deliberate, because an unstated position triages as a
    risk in its own right (`domain/safety.ts`) and guessing is exactly what
    that rule exists to prevent. Measured on the live page:
    `disabled: true`, `pointer-events: none`, `opacity: 0.65`,
    `cursor: pointer`, on a full-strength red button against a dark page. It
    looked enabled, kept the hand cursor, swallowed the click and explained
    nothing. `panels/driverRequest.js` now renders a line under it saying which
    of the two conditions is holding it, and nothing at all when it works.

    **The fleet dashboard read "No connection" permanently.** `pages/fleet.js`
    opens no socket on purpose — a fleet manager gets a coalesced summary, not
    a live feed — but `fleet.html` still carried the connection badge, and
    `state.connection` never left its initial `'disconnected'`. The badge
    un-hid the moment somebody signed in and then reported, forever, a socket
    nobody had ever opened. That is the same wrong sentence `panels/session.js`
    was already fixed for in the signed-out case; the fix covered "no session
    yet" and not "this page has no socket". The badge is gone from that page;
    the Refresh button is its honest affordance. (That page has since been cut
    entirely — §19. The lesson outlived it: a status badge has to report the
    thing it is actually wired to, not the thing the other pages wire it to.)

47. **A TECHNICIAN COULD NEVER RECEIVE THEIR FIRST OFFER — the subscription was
    a closed circle.** Fixed.

    `standingRoomsFor` (`realtime/rooms.ts`) gave a TECHNICIAN no rooms, on the
    stated and reasonable grounds that their interest is per-job and each job
    room must be authorised against the database. So a technician's socket was
    only ever in `job:<id>` rooms for jobs a `/technician/work` fetch had
    already returned, and `pages/technician.js` re-fetched only from
    `onJobEvent`. Trace an offer for a job they have never seen:

        offer written → TECHNICIAN_OFFER_SENT emitted to job:<id>
        → technician is not in that room (the job is not theirs yet)
        → no event reaches the page
        → onJobEvent never fires → refreshWork() never runs
        → nothing on screen, and there is no polling behind it

    The page's only `setInterval` ticks the clock for the countdown; it does not
    fetch. So the offer was invisible for the whole forty-five seconds of its
    life and then timed out. **The condition for hearing about an offer was
    already being on the job the offer was for.** Every first offer expired
    unseen, which from the technician's chair is a surface that never shows
    anything, and from the dispatcher's is a crew that never answers.

    Found by executing a reassignment against a technician window parked open
    and watching nothing happen; confirmed against `technician_offers`, where
    the row existed with status TIMEOUT and an `expires_at` forty-five seconds
    after the dispatcher's click.

    THE FIX IS ONE STANDING ROOM PER TECHNICIAN, `technician:<technicianId>`,
    joined on connect, plus `technicianRoomForEvent` naming the events that must
    reach a technician who has no other connection to the job. That list has
    exactly one member, `TECHNICIAN_OFFER_SENT`, and is deliberately a named set
    rather than "anything carrying a technicianId": once the job is theirs they
    are in its room and hear everything through it, so each addition is a
    decision that something must reach a stranger to the job. The room carries
    no authorisation of its own — it is keyed by the caller's own `actorId` from
    their token, so a technician can only ever be in their own.

    Verified live: technician page signed in and left untouched, reassignment
    executed over the API, and the offer appeared on screen with its countdown
    running, without a reload.

48. **A PERMANENTLY DEGRADED ROUTING LAYER LOOKS NORMAL ON THE BANNER.** OSRM
    failure is handled correctly everywhere except in the one place an operator
    would look. `src/infra/routing.ts` wraps every call: unreachable, non-200,
    a bad `code`, or a timeout all fall through to a haversine estimate, and the
    result carries `method: 'HAVERSINE_FALLBACK'` and `degraded: true` rather
    than being silently substituted. `generateCandidates` copies that onto every
    option as `travelEstimateDegraded`.

    **And nothing reads it.** The field is set in `src/engine/candidates.ts` and
    has no consumer: `persistSolverRun` does not write it, `dispatch_options`
    has no column for it, and the inspector does not render it. So the
    dispatcher approving a plan cannot tell whether it was built on real road
    times or on straight lines inflated by a 1.4 road factor. The driver is
    better served than the dispatcher here — `eta_estimates.degraded` is a real
    column and the driver's arrival card is flagged from it.

    Worse, the health ladder has no routing component at all. The seven are
    `AI_EXTRACTION`, `GPS`, `WEBSOCKET`, `SOLVER`, `PAYMENTS`, `CREW_ON_SHIFT`
    and `DISPATCH_CORE`. An instance deployed with OSRM down, or pointed at a
    URL nothing serves, reports **"All systems normal"** while every dispatch
    decision it makes is a guess. That is invariant 8 — every degraded state is
    visible to an operator — not holding for the component whose absence changes
    the most decisions. `docker-compose.yml`'s own comment calls a missing OSRM
    "an EXPECTED, handled state", which is true of the fallback and not of the
    silence.

    Measured, same job and crew: 1.7 min and `degraded=true` with OSRM down
    against 1.0 min and `degraded=false` with it up, where the real route was
    698.7 m and 62.1 s. The error is roughly 70% on a short job, and it is
    unsigned — haversine cannot know about one-way roads or a central divider,
    so it is sometimes optimistic and sometimes not.

    **The fix: a `ROUTING` probe on the ladder.** `src/health/probes.ts` already
    has the shape for it — one function returning a `ComponentReading`, added to
    `probeAll` and to the component list in `src/domain/healthLadder.ts` with a
    label and a fallback sentence. Two honest implementations:

    - **Cheap and immediate:** count options from the most recent solver run
      whose travel estimate was degraded, the way `probeGps` counts stale
      positions. DEGRADED when any recent decision used the fallback, with the
      detail reading "N of M options in the last solve used a straight-line
      estimate". Needs `travelEstimateDegraded` persisted on `dispatch_options`
      first — one column and one line in `persistSolverRun` — which is worth
      doing anyway, since it is the same field the inspector should be showing.
    - **Direct:** ask OSRM for one known-good short route on each health tick
      and report on the answer. Simpler to write and it adds an outbound call
      on a timer, which is acceptable in the worker (it is not in a decision
      path, so invariant 10 is untouched) but is a liveness check rather than
      evidence about the decisions actually made.

    I would do both, in that order. It is NOT CRITICAL under the ladder's own
    definition — dispatch continues and the fallback is deterministic, so the
    evaluation harness is unaffected (it passes `haversineTravelTimes`
    deliberately and always has) — but DEGRADED is exactly what it is, and the
    banner should say so.

## 16. How I Would Improve It

**First, above everything below: decide what a dispatcher pressing Solve is
allowed to do** (§15.41). The reservation saga has one caller and it is the
re-plan path, so the console can plan a whole board and dispatch none of it.
The two honest options are that taking a plan raises a RECOMMEND per
assignment — which is the shape every other decision in this system already
has — or that it reserves directly and the action queue keeps only the re-plan
case. Either closes five dead job statuses with it. It is one call in
`decisionRecords.ts` and a product decision I have not made rather than an
engineering one I have not done, which is exactly why it survived four
checkpoints.

**Second: decide what a workshop is** (§15.44). Today it is a row the solver
reasons about; leg 3 of the saga needs something that can be asked and can
answer. The cheapest honest version is not an integration — it is a dispatcher
confirming a destination by phone on the workshop's behalf, which is what an
operator would do on day one and which needs one route and one button. A
workshop login or a webhook is the version that scales, and neither is a Phase
22 job that was missed; it was never specified. A tow rung on the technician's
ladder follows it.

Then, in the order I would actually do it: wire the triggers that already have
event sources as Phases 15/15b/15c build them, and raise `UNIT_BREAKDOWN`'s
missing owner as a plan gap; make `safetyLevel` mutable with an audit trail, because
invariant 4 currently rests on a stale value; a solver-level fallback when a
job's only rejections are SLA ones; idempotency keys on the two external
mutations; a travel-time cache; and an owner column for saga recovery instead
of a staleness heuristic. Since the checkpoint: a partial unique index behind
the cross-tenant contention guard; the Phase 15c coverage-cap booking gap
that cutting the fleet dashboard exposed rather than fixed; a `ROUTING`
component on the health ladder, with `travelEstimateDegraded` persisted on
`dispatch_options` and shown in the inspector, so an instance running on
straight-line estimates stops reporting itself healthy (§15.48 — the cheapest
real gap on this list); and measuring `REFUSAL_DISTANCE_PENALTY_KM` against
what a real dispatcher would actually trade, the same way the SLA breach curve
is still a ruler rather than a fitted model. The largest single piece is the coverage engine (Phases 23–24,
cut — see §19): pre-position idle capability against a bucketed empirical
demand rate, score every reposition through the dispatch cost function, gate
it behind the four anti-thrash guards, and then run the ablation that decides
whether it earns its place at this fleet size.

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
- Built a **deterministic evaluation harness** replaying six seeded scenarios
  through the production engine against four policies, reporting ten metrics
  and printing the scenarios where the proposed approach loses. Byte-identical
  stdout for a fixed seed (verified again at the Phase 22 checkpoint). It names
  the one scenario the proposed policy loses on jobs served (ambiguous-diagnosis,
  19/60 against 22/60), and an earlier version surfaced a defect in which a job
  past its SLA window became permanently undispatchable.
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
- Built an **inventory layer with a reconciliation invariant** — a cached
  quantity checked against an append-only movement ledger
  (`starting_qty + SUM(delta) = quantity`) — feeding a real dispatch
  decision: stock whose count is UNVERIFIED is treated as absent, and a
  sourcing detour past a 45-minute ceiling is a hard rejection rather than
  an expensive option.
- Extended the cost function and the assignment to price a **contractual SLA
  obligation as a signed credit** rather than a penalty, and made **safety
  a lexicographic ordering over the global assignment itself** (not only
  per-job ranking) by solving one Hungarian assignment per safety band —
  proved byte-identical against the evaluation harness's own outcome metrics
  when no two safety levels actually compete.
- Built **per-tenant isolation as a Prisma client extension rather than a
  filter every query has to remember** — one place decides the tenant a read
  is scoped to, a caller with no tenant gets a value that matches no rows
  rather than a widened query, and a tenant asking for another tenant's job
  gets 404 rather than 403. Paired with cross-tenant contention that
  ESCALATES: when a contract job and a consumer job want the same scarce van
  at the same safety level, both sides are priced and the choice is put to a
  human rather than made silently.
- Built an **intake prior that reuses the SAME Bayesian update mechanism a
  symptom answer goes through**, so a vehicle's own incident history is just
  another observation about the same distribution — measured: two prior
  incidents cut a stated symptom's question count from one to zero.
- Built a **destination network with a learned acceptance probability** — a
  Beta-Bernoulli conjugate prior over accept/decline/timeout outcomes, no
  training loop — that a real cost term prices into which workshop a tow is
  sent to, resolved once per job inside the same candidate-generation pass
  that resolves part sourcing, so a genuine third dimension of choice never
  grew the assignment matrix. Measured: a controlled decline-history
  simulation moved the learned probability from a 0.8 cold-start prior to
  exactly 0.2 in the affected bucket, and the workshop ranking flipped
  accordingly in a real solve.
  **Say "verified against fabricated ground truth", never "learned from
  operational data."** The outcomes came from
  `scripts/simulate-200-offers.js`; no workshop has ever answered anything in
  this system, because there is no workshop actor to answer with (§15.44). In a
  running instance `acceptance_outcomes` is empty, every workshop sits on the
  cold-start prior, and the refusal-risk term therefore ranks nothing. The
  estimator is real and the operational history is not.

Not claimable: dispatch quality against real breakdowns, latency under load,
throughput, and anything about the Anthropic provider path beyond "it
compiles". Not claimable either: a capped contract's remainder reaching the
right ledger account, a fleet manager surface of any kind (cut — §19), or the
Razorpay adapter (22b, not built).

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
- **Conjugate prior / Beta-Bernoulli update** — a prior distribution family
  that stays in the same family after being updated with evidence, so the
  posterior has a closed form (`(priorAlpha + successes) / (priorAlpha +
  priorBeta + total)`) instead of needing numerical estimation.
- **Cold start** — the estimate a system gives with zero observations; here,
  exactly the prior, not a special case.
- **Denormalisation for a hot aggregate read** — a foreign column copied
  onto a table it is reached through, traded deliberately against a join,
  because the query needs it on every solve and the source of truth is one
  write away.
- **Reconciliation invariant** — an anchor value plus a ledger whose sum
  must equal it, checked rather than trusted (`starting_qty + SUM(delta) =
  quantity`; the double-entry balance is the money-shaped version of the
  same idea).

## 19. Current Project State

**Phases 0–22 complete — the build plan's recommended ship point.** 970 fast
tests across 63 files (3 skipped), plus a 12-test concurrency suite against a
real Postgres container started by the suite itself. `tsc --noEmit` (src,
tests, evaluation, prisma) and `eslint src evaluation` clean. `npm run eval`
reruns byte-identical outcome metrics across six scenarios (parts-stockout
was added at Phase 19) and the four policies Phase 10 built — only the
trailing "solver wall clock p95" block, which the harness labels
not-reproducible, moves run to run.

Working, in the order it was built:

- **Foundation** — two processes, Zod-validated env, pino with request ids,
  real dependency health checks; 85 tables with append-only triggers; an
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
- **The solver** — candidates, ELEVEN feasibility reason codes, a per-fault
  duration model, an EIGHT-term cost function, FOUR weight vectors, a
  lexicographic safety comparator now applied to the global assignment as
  safety BANDS (one Hungarian run per level) as well as per-job ranking, a
  hand-written Hungarian assignment with zone partitioning, and a deadline
  that returns the best plan found. Part sourcing and destination selection
  both resolve inside candidate generation, one per pair and one per job
  respectively, so the assignment matrix never grew past jobs × (unit,
  technician).
- **The evaluation harness** — six scenarios, four policies, ten metrics, a
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
- **Parts and inventory** — a cached quantity reconciled against an
  append-only movement ledger, confidence as a function of age computed on
  read, client-minted idempotency keys on every write.
- **Part-aware feasibility** — sourcing resolved inside candidate
  generation, `PART_UNAVAILABLE` real, an eighth cost term, a fail-closed
  UNVERIFIED rule, and a sixth evaluation scenario measuring the stockout
  cost of skill-only dispatch.
- **Tenancy and contracts** — contract terms pinned at intake alongside the
  price list and settlement path, a contract-exposure cost term signed as a
  credit, safety bands in the global assignment, cross-tenant contention
  escalated to an APPROVE card, vehicle registration checked against two
  tenancy conflicts.
- **The fleet-vehicle intake prior and coalesced fleet notifications** — a
  vehicle's own incident history folded into its starting fault distribution
  through the symptom Bayes update, and fleet-manager notifications coalesced
  on a ten-minute window through the same queue the driver's ninety-second
  one already used. Phase 21's fleet manager DASHBOARD was also built and has
  since been **cut** — on the build plan's own instruction to keep the tenancy
  in the engine and drop the UI. There are three browser surfaces, not four.
  `src/domain/repeatPattern.ts` outlived it as a tested rule with no caller
  (§15.35).
- **The workshop network** — brand and EV-class authorisation as separate
  reason codes, opening hours read in IST, a Beta-Bernoulli learned P(accept)
  with no ML infrastructure, a destination-refusal cost term priced in
  minutes, and the saga's third leg — real since Phase 12 — finally called
  by production code.

**Verified in a browser:** the driver's page — sign-in, free-text description,
the DEGRADED banner, the symptom picker, safety, location, job creation and the
live status panel. The dispatcher and technician pages have been exercised over
HTTP but not clicked through end to end.

**Not started, and Phases 23–24 cut deliberately as headroom.** The Razorpay
adapter (22b) is unbuilt. Phases 23 (a coverage / repositioning engine) and 24
(its ablation) are a deliberate cut, not an oversight — the build plan names
23–26 as "first thing to cut" and Phase 22 as the ship point. Phase 23 is a
whole new subsystem orthogonal to the thesis: `ZoneDemandStat`, `CoverageGap`,
`RepositionRecommendation`/`RestockRecommendation`, a write-capable
recommendation loop scored through the *same* cost function as dispatch, four
anti-thrash guards (minimum-improvement, cooldown, hysteresis, a live cap with
SUPERSEDE), two new unit states (REPOSITIONING/RESTOCKING, both still
dispatchable), and a real-Postgres test for two dispatchers racing one
recommendation. The dispatch thesis — time-to-resolution, belief-driven, risk
priced into the objective — is already built and measured across six scenarios;
a half-tested recommendation system bolted on would be the weakest code in a
repo whose whole point is that every line is defensible. The stronger interview
position is the scoped-not-built one: the tables, the guards, and the honest
ablation ("I measured it and it did not help at this fleet size" is a valid
result) as a description of what comes next.

**Known-stale data:** the development database carries INTAKE jobs left by
earlier phases and manual runs of the Phase 22 check script
(`sim200-*`-prefixed rows against a real seeded workshop), none of it reachable
by a real dispatch (the check script's own job is RESOLVED on write) but all
of it real rows a fresh `npm run db:seed` will not remove on its own. A demo
should run against a fresh database, or the queue should be aged first.
