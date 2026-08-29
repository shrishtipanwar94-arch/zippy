# Codemap

Where things live, the order to read them in, and the call paths that matter.
Refreshed at the same checkpoints as INTERVIEW.md (end of Phases 4, 9, 13, 17,
22). Current through Phase 4.

## 1. Where things live

```
src/index.ts                    web process: app + Socket.IO on one HTTP server
src/worker.ts                   worker process: heartbeat only until BullMQ (Phase 5)

src/api/app.ts                  builds the Express app — request id, CORS, JSON, routes, /public
src/api/health.ts               GET /health — real SELECT 1 + PING, 503 when a dep is down
src/api/auth.ts                 POST /auth/login, /auth/refresh; resolves tenant + actor id
src/api/jobs.ts                 GET /jobs, /jobs/:id, /units; PATCH /jobs/:id/assign (placeholder)
src/api/intake.ts               POST /jobs/intake, /jobs/:id/answers; GET /jobs/:id/next-question
src/api/middleware/            authenticate (bearer + RBAC gate), errors (JSON, one place)

src/auth/tokens.ts              JWT mint/verify, two secrets; passwords.ts is argon2id
src/auth/permissions.ts         role -> resource -> action table; the job-ownership rule
src/auth/tenantScope.ts         pure "which tenant filters this query" decision
src/auth/context.ts             AsyncLocalStorage carrying who is asking

src/infra/config.ts             env parsed once through Zod; process exits if invalid
src/infra/prismaBase.ts         the raw, unscoped Prisma client (logger.ts is one pino)
src/infra/db.ts                 prismaBase + both read-isolation extensions — use this
src/infra/tenantScopeExtension.ts   injects the tenant filter into every scoped query
src/infra/jobOwnershipExtension.ts  narrows a DRIVER/TECHNICIAN to their own jobs
src/infra/redis.ts              the single ioredis connection (cache/queues only)

src/domain/faults.ts            12 fault codes, base rates, fault -> capability
src/domain/symptoms.ts          the structured symptom payload (Phase 16 replaces its source)
src/domain/faultRules.ts        the naive-Bayes table; classify, and generate for the simulator
src/domain/entropy.ts           Shannon entropy, Bayes update, ranking
src/domain/questions.ts         the 7-question catalogue and P(answer | fault)
src/domain/questionSelection.ts expected information gain and the four stop conditions
src/domain/capabilitySet.ts     distribution -> the skills to send; when it stops mattering
src/domain/safety.ts            9 triage rules -> NORMAL | ELEVATED | HIGH_RISK + reason codes
src/domain/location.ts          location schema, carriageway from heading, on-highway derivation
src/domain/geo.ts               haversine distance, nearest zone

src/intake/createJob.ts         a breakdown report becomes a job, in one transaction
src/intake/answers.ts           record one answer; entropy before/after; next step
src/intake/session.ts           the state one job's intake is in
src/intake/hypothesis.ts        persist and read the fault distribution
src/intake/events.ts            append a JobEvent with a per-job sequence
src/intake/transaction.ts       retry the whole transaction on collision; flush the outbox

src/commit/assignUnit.ts        manual assignment; conditional claim. PLACEHOLDER, dies at Phase 9

src/realtime/server.ts          Socket.IO; JWT on the handshake; job:subscribe
src/realtime/rooms.ts           job / zone / tenant rooms and who may enter them
src/realtime/publish.ts         THE fan-out point — nothing else calls io.emit
src/realtime/outbox.ts          per-transaction event buffer, flushed only after commit
src/realtime/replay.ts          everything after a client's lastEventSequence

src/sim/cli.ts                  npm run sim — one-shot or --live, with a kill switch
src/sim/runner.ts               the loop; calls the REAL intake functions, not a copy
src/sim/scenarios.ts            Poisson arrivals, symptoms, situation, location
src/sim/config.ts               seed, rate, duration, mixes; random.ts is mulberry32
src/sim/driverAnswers.ts        a simulated driver answering from the hidden true fault
src/sim/actors.ts               stubs for Phases 12-19: latency, re-diagnosis, stock

src/engine/                     EMPTY — candidates, feasibility, cost (Phase 6+); no db imports

public/js/state.js              the ONE client state object; idempotent applyJobEvent
public/js/socket.js             the socket; resubscribes with a cursor on reconnect
public/js/panels/*.js           one render(state) each; nothing else touches the DOM
public/js/pages/*.js            driver / technician / dispatcher wiring

prisma/schema.prisma            83 tables; append-only triggers; version columns
prisma/seed.ts                  idempotent; order matters, each step needs the last
prisma/seed/crews.ts            which technician is in which unit, by rarest capability
prisma/seed/technicians.ts      31 technicians, deliberately uneven capability matrix

tests/intake.test.ts            the four pure pieces: rules, entropy, safety, location
tests/intakeRoute.test.ts       POST /jobs/intake over HTTP — the wiring a unit test cannot see
tests/realtime.test.ts          rooms, handshake, fan-out, replay
tests/assign.test.ts            assignment, RBAC, and the one-unit-two-jobs race
tests/crews.test.ts             the crewing pairing is sound and deterministic
tests/{rbac,tenancy,ownership}.test.ts   the three authorisation layers
tests/concurrency/              EMPTY — testcontainers invariant tests (Phase 11+)
```

## 2. Reading order

1. `src/infra/config.ts` — nothing runs without valid env.
2. `src/api/app.ts` — how a request is wrapped and which routers exist.
3. `src/api/middleware/authenticate.ts` — how a caller becomes an identity.
4. `src/infra/db.ts` and the two extensions — read this before any query, or
   the `where` clauses in routes will look dangerously incomplete.
5. `src/domain/symptoms.ts` — what a breakdown report actually is.
6. `src/domain/faultRules.ts` — symptoms to a distribution over faults.
7. `src/domain/entropy.ts` — the two pieces of maths everything else uses.
8. `src/domain/questionSelection.ts` — the part that matters: which question next.
9. `src/domain/safety.ts` and `location.ts` — the other two intake outputs.
10. `src/intake/createJob.ts` — all of the above applied in one transaction.
11. `src/intake/transaction.ts` and `src/realtime/outbox.ts` — read together;
    the retry and the publish-after-commit rule only make sense as a pair.
12. `src/realtime/publish.ts` then `rooms.ts` — one event to browsers.
13. `src/commit/assignUnit.ts` — the conditional claim, and the shape Phase 12
    generalises into the saga.
14. `src/sim/runner.ts` — how the whole thing is exercised reproducibly.
15. `public/js/state.js` — the client discipline in one file.

## 3. Call paths

```
POST /jobs/intake
  → api/intake.ts        authenticate → requirePermission('create','job')
                         resolve driver + vehicle via SCOPED prisma (404 if unseen)
  → intake/createJob.ts  createIntakeJob(prismaBase, …)
    → runIntakeTransaction()            [ intake/transaction.ts ]
      → domain/faultRules.classifySymptoms()
      → domain/location.locationColumns()      → isOnHighway(roadPosition)
      → domain/safety.buildSafetyContext() → triageSafety()
      → geo.nearestZone() → job.create() → symptomReport → locationEvent
      → intake/hypothesis.recordHypothesis()
      → intake/events.appendJobEvent() × 5     → realtime/outbox.recordForPublish()
      → session.nextQuestionView() → domain/questionSelection.decideNextQuestion()
    ← commit
    → realtime/publish.publishJobEvents()      → rooms.roomsForJobEvent() → io.to().emit()

POST /jobs/:id/answers          (the diagnosis changing)
  → api/intake.ts        → intake/answers.recordIntakeAnswer()
    → session.loadIntakeSession() → nextStepFor()   guard: is this the pending question?
    → questionSelection.posteriorForAnswer() + expectedInformationGain()
    → intakeAnswer.create(entropyBefore, entropyAfter, expectedGain)
    → hypothesis.recordHypothesis() → appendJobEvent() × 2 (+ INTAKE_COMPLETED)
    ← commit → publishJobEvents()

PATCH /jobs/:id/assign          (placeholder for the Phase 12 saga)
  → api/jobs.ts          requirePermission('update','jobAssignment')   DISPATCHER only
                         scoped prisma.job.findFirst → 404 if unseen
  → commit/assignUnit.ts assignUnitToJob()
    → takeUnit()      UPDATE units WHERE id=? AND version=? AND status='AVAILABLE'
    → attachToJob()   UPDATE jobs  WHERE id=? AND version=?
                      zero rows changed → AssignmentError('LOST_RACE') → rollback
    → appendJobEvent('UNIT_ASSIGNED') ← commit → publishJobEvents()

client reconnect
  → public/js/socket.js  on 'connect', resubscribe every job with cursorFor(jobId)
  → realtime/server.ts   job:subscribe → runWithAuthContext(auth, async () => …)
                         scoped read decides; join room FIRST, then read the replay
  → realtime/replay.js   events after the cursor, or truncated:true
  → public/js/state.js   applyJobEvent drops any sequence already applied
```

The dispatch and saga-compensation call paths do not exist yet.
