# Codemap

Where things live, the order to read them in, and the call paths that matter.
Refreshed at the same checkpoints as INTERVIEW.md (end of Phases 4, 9, 13, 17,
22). Current through Phase 9.

## 1. Where things live

```
src/index.ts                    web process: app + Socket.IO on one HTTP server
src/worker.ts                   worker process: starts/stops the four BullMQ workers

src/api/app.ts                  builds the Express app — request id, CORS, JSON, routes, /public
src/api/solve.ts                POST /solve — snapshot, solve, persist, return three plans
src/api/intake.ts               POST /jobs/intake, /jobs/:id/answers; GET next-question
src/api/{jobs,auth,health}.ts   GET /jobs(/:id); login + refresh; real SELECT 1 + PING
src/api/middleware/             authenticate (bearer + RBAC gate), errors (JSON, one place)

src/auth/                       tokens (JWT, two secrets), passwords (argon2id), permissions
                                (role -> resource -> action), tenantScope, context (ALS)

src/infra/config.ts             env parsed once through Zod; process exits if invalid
src/infra/db.ts                 prismaBase + both read-isolation extensions — use this
src/infra/tenantScopeExtension.ts   injects the tenant filter into every scoped query
src/infra/jobOwnershipExtension.ts  narrows a DRIVER/TECHNICIAN to their own jobs
src/infra/routing.ts            OSRM /route and /table, haversine fallback, degraded flag
src/infra/{prismaBase,logger,redis}.ts   the raw unscoped client; one pino; the
                                fail-fast ioredis connection used only by health checks

src/domain/faultRules.ts        the naive-Bayes table; classify, and generate for the sim
src/domain/entropy.ts           Shannon entropy, Bayes update, ranking
src/domain/questionSelection.ts expected information gain and the four stop conditions
src/domain/capabilitySet.ts     distribution -> the skills to send; when it stops mattering
src/domain/safety.ts            9 triage rules -> NORMAL | ELEVATED | HIGH_RISK + codes
src/domain/{faults,questions,symptoms,location,geo}.ts   12 faults, the 7-question
                                catalogue, the payload, carriageway/highway, haversine

src/engine/candidates.ts        builds (unit, technician) options for a job; snapshot types
src/engine/feasibility.ts       ten hard filters, first match wins, returns reason codes
src/engine/durations.ts         per-fault diagnose / resolve / escalation minutes
src/engine/cost.ts              the five weighted terms and the three weight vectors
src/engine/ranking.ts           invariant 4's lexicographic comparator — safety above cost
src/engine/allocation.ts        the Hungarian algorithm, by hand; padding; UNAVAILABLE_COST
src/engine/solve.ts             THE ORCHESTRATOR — snapshot hash, three plans, partitioning

src/intake/createJob.ts         a breakdown report becomes a job, in one transaction
src/intake/transaction.ts       retry the whole transaction on collision; flush the outbox
src/intake/{answers,session,hypothesis,events}.ts   one answer + entropy, intake state,
                                the distribution, JobEvent append with a per-job sequence

src/commit/dispatchSnapshot.ts  the ONE place a DispatchSnapshot is read out of Postgres
src/commit/persistSolverRun.ts  the ONLY write in the solve path: run, options, variants

src/queues/idempotent.ts        runIdempotently — the log insert and the effect, one txn
src/queues/debounce.ts          BullMQ deduplication + delay; first trigger in a window wins
src/queues/{connection,names,backoff,deadLetter,queues,board}.ts   one shared Queue
                                connection (one per Worker, never shared), backoff, DLQ, board

src/workers/runWorkers.ts       one Worker per queue name; dead-letter wired on 'failed'
src/workers/cleanup.ts          real work: expire idempotency keys, release expired holds
src/workers/{solver,notification,offerExpiry}.ts   enqueueSolve + a no-op processor (no
                                trigger until Phase 13); plumbing for Phases 15b and 12

src/realtime/publish.ts         THE fan-out point — Server or Redis emitter, nothing else
src/realtime/outbox.ts          per-transaction event buffer, flushed only after commit
src/realtime/{server,rooms,replay}.ts   Socket.IO with JWT on the handshake and the Redis
                                adapter; job/zone/tenant rooms; replay after a cursor

src/sim/runner.ts               the loop; calls the REAL intake functions, not a copy
src/sim/{scenarios,cli,config,random}.ts   Poisson arrivals and the situation mix;
                                npm run sim; seed/rate/mixes; mulberry32

public/js/state.js              the ONE client state object; idempotent applyJobEvent
public/js/socket.js             the socket; resubscribes with a cursor on reconnect
public/js/panels/plans.js       the three plan cards — what replaced the unit dropdown
public/js/{panels,pages}/*.js   one render(state) each; per-role page wiring

prisma/schema.prisma            83 tables; append-only triggers; version columns
prisma/seed.ts + seed/          idempotent, order-dependent; 31 technicians on a
                                deliberately uneven capability matrix, crewed by rarest skill
scripts/setup-osrm.sh           one-time: Overpass extract -> extract/partition/customize

tests/allocation.test.ts        the Hungarian algorithm vs brute force, 300 seeded matrices
tests/solve.test.ts             global beats nearest; zone partitioning's cost; zero writes
tests/queues.test.ts            idempotency under a real concurrent race; backoff; dead-letter
tests/{candidates,feasibility,cost,intake,realtime}.test.ts   each engine stage alone;
                                the four pure intake pieces; rooms/handshake/fan-out/replay
tests/{rbac,tenancy,ownership}.test.ts   the three authorisation layers
tests/concurrency/              EMPTY — testcontainers invariant tests (Phase 11+)
```

## 2. Reading order

1. `src/infra/config.ts` — nothing runs without valid env.
2. `src/api/app.ts` — how a request is wrapped and which routers exist.
3. `src/infra/db.ts` and the two extensions — read before any query, or the
   `where` clauses in routes look dangerously incomplete.
4. `src/domain/faultRules.ts` then `entropy.ts` — a symptom payload becomes a
   distribution over faults, and the maths everything downstream consumes.
5. `src/intake/createJob.ts` — all of the above in one transaction; read
   `intake/transaction.ts` with `realtime/outbox.ts`, since the retry and the
   publish-after-commit rule only make sense as a pair.
6. `src/api/solve.ts` — the dispatch entry point, short on purpose.
7. `src/engine/solve.ts` — **the orchestrator; read this before the parts.**
   The five numbered steps below are the same five it runs.
8. `src/engine/candidates.ts` — what an option is, and the snapshot types the
   whole engine speaks in.
9. `src/engine/feasibility.ts` — invariant 3 in code: filters with reason
   codes, first match wins, never a penalty.
10. `src/engine/cost.ts` with `durations.ts` — the objective function, and the
    per-fault model the expected-time term is built from.
11. `src/engine/ranking.ts` — invariant 4, deliberately in its own file so it
    cannot become a sixth weighted term.
12. `src/engine/allocation.ts` — the Hungarian algorithm. Read the header
    comment first; the code is short once the idea is clear.
13. `src/commit/dispatchSnapshot.ts` then `persistSolverRun.ts` — how the pure
    engine is fed, and the only write in the path.
14. `src/queues/idempotent.ts` — the pattern every background processor rests
    on, and the one thing to understand before Phase 11's holds.

## 3. Call paths

```
POST /solve                                              (a job being dispatched)
  → api/solve.ts             requirePermission('read','solverRun')   DISPATCHER only
  → commit/dispatchSnapshot.buildDispatchSnapshot(prismaBase)
                             pending jobs + units + technicians + shifts + zones
  → engine/solve.solve()
    → candidates.generateCandidates()   → infra/routing.travelTimeMatrix()   [ OSRM ]
    → feasibility.checkFeasibility()    → rejected: { option, code, detail }
    → cost.scoreOption() × 3 weight vectors
    → solve.partitionByZone()           only above SOLVER_ZONE_PARTITION_THRESHOLD
    → solve.buildPlan() × 3             → allocation.solveAssignment()
                                          → allocation.hungarian()
    → solve.hashSnapshot()
  ← three plans; NOTHING has been written
  → commit/persistSolverRun.persistSolverRun()
    → solverRun.create() → dispatchOption.createMany() × 2 → planVariant.create() × 3

POST /jobs/:id/answers                                   (a diagnosis changing)
  → api/intake.ts → intake/answers.recordIntakeAnswer()
    → session.loadIntakeSession() → nextStepFor()   guard: is this the pending question?
    → questionSelection.posteriorForAnswer() + expectedInformationGain()
    → intakeAnswer.create(entropyBefore, entropyAfter, expectedGain)
    → hypothesis.recordHypothesis() → appendJobEvent() × 2 (+ INTAKE_COMPLETED)
    ← commit → publishJobEvents()
  (the re-plan trigger belongs here — workers/solver.enqueueSolve() — Phase 13)
```

A saga compensating has no call path yet: no plan can be committed to an
assignment until Phase 11's holds and Phase 12's saga exist.
