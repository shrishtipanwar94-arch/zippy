# Codemap

Where things live, the order to read them in, and the call paths that matter.
Refreshed at the same checkpoints as INTERVIEW.md (end of Phases 4, 9, 13, 17,
22). Current through Phase 13.

## 1. Where things live

```
src/index.ts                web process: app + Socket.IO on one HTTP server
src/worker.ts               worker process: saga recovery, THEN four BullMQ workers

src/api/solve.ts            POST /solve — snapshot, solve, persist, three plans
src/api/diagnosis.ts        POST /jobs/:id/diagnosis — the on-site re-diagnosis
src/api/actions.ts          GET /actions; execute a RECOMMEND; approve an APPROVE
src/api/app.ts              builds the app; intake.ts, jobs.ts, auth.ts, health.ts
src/api/middleware/         authenticate (bearer + RBAC gate); errors, in one place

src/auth/                   JWT pair, argon2id, the role -> resource -> action table,
                            tenant scope, ALS request context
src/infra/config.ts         env parsed once through Zod; process exits if invalid
src/infra/db.ts             prismaBase + both read-isolation extensions — use this
src/infra/routing.ts        OSRM /route and /table; haversine fallback; degraded flag
src/infra/                  the two read-narrowing extensions, raw client, pino, redis

src/domain/replanTriggers.ts   THE eight re-solve triggers; move threshold; thrash cap
src/domain/actionTiers.ts      AUTO / RECOMMEND / APPROVE as a table, not if-statements
src/domain/faultRules.ts       the naive-Bayes table; classify, and generate for the sim
src/domain/questionSelection.ts   expected information gain; the four stop conditions
src/domain/capabilitySet.ts    distribution -> the skills to send; when it stops mattering
src/domain/                    entropy, safety triage, faults, questions, symptoms,
                               location/carriageway, haversine geo

src/engine/candidates.ts    builds (unit, technician) options; the snapshot types
src/engine/feasibility.ts   ten hard filters, first match wins, returns reason codes
src/engine/cost.ts          five weighted terms, three vectors; durations.ts feeds it
src/engine/ranking.ts       invariant 4's lexicographic comparator — safety above cost
src/engine/allocation.ts    the Hungarian algorithm, by hand; padding; UNAVAILABLE_COST
src/engine/solve.ts         THE ORCHESTRATOR — snapshot hash, three plans, partitioning

src/commit/dispatchSnapshot.ts   the ONE place a snapshot is read out of Postgres
src/commit/persistSolverRun.ts   the only write in the solve path
src/commit/holds.ts         version-checked unit holds; release is idempotent
src/commit/offers.ts        technician offers: PROPOSED -> ACCEPTED|DECLINED|TIMEOUT
src/commit/saga.ts          the three-leg reservation, compensations in reverse
src/commit/sagaRecovery.ts  startup: commit ALL_ACCEPTED, compensate everything stale
src/commit/redispatch.ts    handleTrigger + executeReassignment — trigger to reservation
src/commit/actionRequests.ts  ActionRequest rows: tier, reason, impact, resolution
src/commit/slaEscalation.ts   the breach follow-up sweep (RECOMMEND, never a gate)

src/intake/createJob.ts     a breakdown report becomes a job, in one transaction
src/intake/transaction.ts   retry the whole transaction on collision; flush the outbox
src/intake/                 one answer + entropy, session state, hypothesis, JobEvent

src/queues/idempotent.ts    runIdempotently — the log insert and the effect, one txn
src/queues/debounce.ts      BullMQ dedup + delay; the FIRST trigger in a window wins
src/queues/                 connections, capped backoff, dead-letter, Bull Board
src/workers/solver.ts       enqueueSolve + the debounced zone re-plan that really solves
src/workers/offerExpiry.ts  time an offer out, THEN advance its saga
src/workers/               runWorkers (one per queue), cleanup (keys, holds, SLA sweep)

src/realtime/publish.ts     THE fan-out point — Server or Redis emitter, nothing else
src/realtime/outbox.ts      per-transaction event buffer, flushed only after commit
src/realtime/               Socket.IO + handshake JWT + Redis adapter; rooms; replay

evaluation/runner.ts        the discrete-event loop; a hidden trueFault drives re-dispatch
evaluation/policies/        fifo | nearest-unit | skill-aware | capability-aware-global
evaluation/                 five seeded scenarios; eight metrics; report; npm run eval

prisma/                     83 tables, append-only triggers, version columns; the seed
scripts/                    setup-osrm.sh; fire-10-triggers-fast.js (the debounce check)
tests/concurrency/          REAL Postgres via testcontainers — holds, offers, mutation
tests/                      redispatch (trigger->saga), saga, allocation vs brute force,
                            solve writes nothing, policy tables, auth layers
public/js/                  one state object; panels render(state); per-role page wiring
```

## 2. Reading order

1. `src/infra/config.ts` — nothing runs without valid env.
2. `src/api/app.ts` — how a request is wrapped and which routers exist.
3. `src/infra/db.ts` and the two extensions — read before any query, or the
   `where` clauses in routes look dangerously incomplete.
4. `src/intake/createJob.ts` — a breakdown becomes a job in one transaction;
   read `intake/transaction.ts` with `realtime/outbox.ts`, since the retry and
   the publish-after-commit rule only make sense as a pair.
5. `src/api/solve.ts` — the dispatch entry point, short on purpose.
6. `src/engine/solve.ts` — **the orchestrator; read this before the parts.**
7. `src/engine/candidates.ts` — what an option is, and the snapshot types.
8. `src/engine/feasibility.ts` — invariant 3 in code: filters with reason codes.
9. `src/engine/cost.ts` with `durations.ts` — the objective function.
10. `src/engine/ranking.ts` — invariant 4, in its own file so it cannot become
    a sixth weighted term.
11. `src/engine/allocation.ts` — the Hungarian algorithm; read the header first.
12. `src/commit/holds.ts` — the conditional UPDATE that IS the concurrency
    argument, written longhand for that reason.
13. `src/commit/saga.ts` then `sagaRecovery.ts` — three legs, compensation in
    reverse, and what a crash leaves behind.
14. `src/domain/replanTriggers.ts` and `actionTiers.ts` — the two policy tables,
    read before the code that applies them.
15. `src/commit/redispatch.ts` — a trigger becomes a reservation.

## 3. Call paths

```
POST /solve                                              (a job being dispatched)
  → api/solve.ts             requirePermission('read','solverRun')   DISPATCHER
  → commit/dispatchSnapshot.buildDispatchSnapshot(prismaBase)
  → engine/solve.solve()
    → candidates.generateCandidates()  → infra/routing.travelTimeMatrix()  [ OSRM ]
    → feasibility.checkFeasibility()   → rejected: { option, code, detail }
    → cost.scoreOption() × 3 weight vectors
    → solve.partitionByZone()          only above SOLVER_ZONE_PARTITION_THRESHOLD
    → solve.buildPlan() × 3            → allocation.solveAssignment() → hungarian()
  ← three plans; NOTHING has been written
  → commit/persistSolverRun.persistSolverRun()

POST /jobs/:id/diagnosis                                 (a diagnosis changing)
  → api/diagnosis.ts    requirePermission('update','jobDiagnosis')   TECHNICIAN
  → faultRules.classifySymptoms() → capabilitySet.requiredCapabilities()
  → hypothesis.recordHypothesis() + events.appendJobEvent('DIAGNOSIS_CHANGED')
  → assignedCrewCanResolve()?
      YES → actionRequests.requestAction('NOTIFY_DIAGNOSIS_CONFIRMED')  AUTO, executed
      NO  → commit/redispatch.handleTrigger('DIAGNOSIS_CHANGED')
              1. shouldEscalateForThrash() → requestAction(ESCALATE_THRASHING_JOB) APPROVE
              2. causesResolve()?
              3. buildDispatchSnapshot({ includeAssigned: true }) → solve() → persist
              4. same assignment as now? → NO_CHANGE, raise nothing
              5. requestAction('REASSIGN_AFTER_DIAGNOSIS_CHANGE')       RECOMMEND
  ← technicianOutcome: WAIT | RELEASE_PENDING

POST /actions/:id/execute                                (a plan becoming real)
  → api/actions.ts      requirePermission('update','actionRequest')   DISPATCHER
  → actionRequests.resolveAction(EXECUTED)
  → redispatch.executeReassignment()
    → releaseCurrentCrew()  only when the new plan drops them; on EXECUTE, not propose
    → commit/saga.startSaga()
      leg 1 → holds.createHold()     UPDATE units WHERE id AND status AND version
      leg 2 → offers.proposeOffer()  → workers/offerExpiry.scheduleOfferExpiry()
      leg 3 → destinationOffer.create()  tows only; workshop side stubbed to Phase 22

a saga compensating                                      (any leg fails)
  → saga.advanceSaga() → compensateSaga()      ← state RELEASED_ALL
    leg 3 → destinationOffer WITHDRAWN
    leg 2 → technicianOffer WITHDRAWN + JobEvent; an ACCEPTED technician gets
            'TECHNICIAN_RELEASED_AFTER_ACCEPT' — they are already driving
    leg 1 → holds.releaseHold()    conditional; a second call is a no-op
    → finishAsRequeued()           REQUEUED + 'DISPATCH_REQUEUED'
  entered from: recordTechnicianDecision · recordDestinationDecision ·
                offerExpiry (timeout) · sagaRecovery (startup)
```
