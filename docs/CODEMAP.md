# Codemap

Where things live, the order to read them in, and the call paths that matter.
Refreshed at the same checkpoints as INTERVIEW.md (end of Phases 4, 9, 13, 17,
22). Current through Phase 17.

## 1. Where things live

```
src/index.ts                web process: app + Socket.IO on one HTTP server
src/worker.ts               worker: saga recovery, THEN queues, THEN the health loop

src/api/app.ts              builds the app and mounts every router
src/api/solve.ts            POST /solve — snapshot, solve, persist, three plans
src/api/intake.ts           POST /jobs/intake[/describe]; next-question; answers
src/api/diagnosis.ts        POST /jobs/:id/diagnosis — the on-site re-diagnosis
src/api/actions.ts          GET /actions; execute a RECOMMEND; approve an APPROVE
src/api/console.ts          the dispatcher board: timeline, decision, scarcity, queue
src/api/driver.ts           GET /jobs/:id/driver-view — every sentence, server-worded
src/api/technician.ts       offers, the status ladder, the completion code
src/api/chat.ts             messages, promotions, and who may confirm which kind
src/api/estimates.ts        estimate, approval, capture — the money surface
src/api/escalation.ts       GET/POST /jobs/:id/escalation — the no-plan handover
src/api/chaos.ts            the break-it panel; mounts NOTHING in production
src/api/health.ts           GET /health — dependencies AND the degradation ladder
src/api/middleware/         authenticate (bearer + RBAC gate); errors, in one place
src/auth/                   JWT pair, argon2id, role -> resource -> action, tenant scope
src/infra/config.ts         env parsed once through Zod; process exits if invalid
src/infra/db.ts             prismaBase + both read-isolation extensions — use this
src/infra/routing.ts        OSRM /route and /table; haversine fallback; degraded flag
src/domain/replanTriggers.ts   THE eight re-solve triggers; move threshold; thrash cap
src/domain/actionTiers.ts      AUTO / RECOMMEND / APPROVE as a table, not if-statements
src/domain/hypothesisView.ts   ONE hypothesis shape, whichever path filled the form in
src/domain/faultRules.ts       the naive-Bayes table; classify, and generate for the sim
src/domain/questionSelection.ts   expected information gain; the four stop conditions
src/domain/capabilitySet.ts    distribution -> the skills to send; when it stops mattering
src/domain/healthLadder.ts     six components, three modes, and the roll-up rule
src/domain/escalationCard.ts   a reason code becomes something a person can act on
src/domain/messageClassifier.ts   a chat message becomes a PROPOSAL, never a change
src/domain/money·ledger·pricing·coverage   paise, double entry, contract caps
src/domain/                    entropy, safety, faults, questions, symptoms, geo,
                               carriageway, the driver's narrative wording, prompts

src/engine/candidates.ts    builds (unit, technician) options; the snapshot types
src/engine/feasibility.ts   ten hard filters, first match wins, returns reason codes
src/engine/cost.ts          five weighted terms, three vectors; durations.ts feeds it
src/engine/ranking.ts       invariant 4's lexicographic comparator — safety above cost
src/engine/allocation.ts    the Hungarian algorithm, by hand; padding; UNAVAILABLE_COST
src/engine/solve.ts         THE ORCHESTRATOR — hash, three plans, partitioning, deadline

src/commit/dispatchSnapshot.ts   the ONE place a snapshot is read out of Postgres
src/commit/persistSolverRun.ts   the only write in the solve path
src/commit/holds.ts         version-checked unit holds; release is idempotent
src/commit/offers.ts        technician offers: PROPOSED -> ACCEPTED|DECLINED|TIMEOUT
src/commit/saga.ts          the three-leg reservation, compensations in reverse
src/commit/sagaRecovery.ts  startup: commit ALL_ACCEPTED, compensate everything stale
src/commit/redispatch.ts    handleTrigger + executeReassignment
src/commit/eventPromotions.ts  a flagged message becomes a job change — with a human
src/commit/estimates·payments·ledger·payouts   the money write path

src/ai/client.ts            the boundary: one SchemaCall type, two providers behind it
src/ai/providers/           anthropic (Messages API) · openAiCompatible (Groq et al)
src/ai/extractSymptoms.ts   no key -> fallback; bad body -> ONE retry; then the picker
src/ai/store.ts             every attempt written down, including the failures

src/health/probes.ts        six questions asked of the real world; none can throw
src/health/state·loop.ts    system_health_states; a bare 15s timer, NOT a queued job
src/chaos/switches.ts       four switches that stay on, in Postgres, dev builds only
src/chaos/actions.ts        four things that happen once, through the real writes

src/intake/createJob.ts     a breakdown report becomes a job, in one transaction
src/queues/idempotent.ts    runIdempotently — the log insert and the effect, one txn
src/queues/debounce.ts      BullMQ dedup + delay; the FIRST trigger in a window wins
src/workers/solver.ts       enqueueSolve + the debounced re-plan; the planner deadline
src/realtime/publish.ts     THE fan-out point — Server or Redis emitter, nothing else
src/realtime/server.ts      handshake JWT, rooms, suppressLiveUpdates for chaos
evaluation/runner.ts        the discrete-event loop; a hidden trueFault drives re-dispatch
evaluation/ai/              108 labelled descriptions, a keyword control, six metrics
prisma/                     84 tables, append-only triggers, version columns; the seed
tests/concurrency/          REAL Postgres via testcontainers — holds, offers, mutation
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
5. `src/ai/extractSymptoms.ts` — the AI's whole footprint: it fills in the form
   step 4 consumes, and every failure lands on the picker.
6. `src/api/solve.ts` — the dispatch entry point, short on purpose.
7. `src/engine/solve.ts` — **the orchestrator; read this before the parts.**
8. `src/engine/candidates.ts` — what an option is, and the snapshot types.
9. `src/engine/feasibility.ts` — invariant 3 in code: filters with reason codes.
10. `src/engine/cost.ts` with `durations.ts` — the objective function; then
    `ranking.ts` for invariant 4 and `allocation.ts` for the assignment.
11. `src/commit/holds.ts` — the conditional UPDATE that IS the concurrency
    argument, written longhand for that reason.
12. `src/commit/saga.ts` then `sagaRecovery.ts` — three legs, compensation in
    reverse, and what a crash leaves behind.
13. `src/domain/replanTriggers.ts` and `actionTiers.ts` — the policy tables,
    read before `src/commit/redispatch.ts`, which applies them.
14. `src/domain/healthLadder.ts` with `src/health/loop.ts` — what the system
    does when a piece of it is missing, and how it notices.

## 3. Call paths

```
POST /solve                                              (a job being dispatched)
  → api/solve.ts             requirePermission('read','solverRun')   DISPATCHER
  → chaos/switches.isChaosOn('SOLVER_TIMEOUT') → deadlineMs          [ edge only ]
  → commit/dispatchSnapshot.buildDispatchSnapshot(prismaBase)
  → engine/solve.solve()
    → candidates.generateCandidates()  → infra/routing.travelTimeMatrix()  [ OSRM ]
    → feasibility.checkFeasibility()   → rejected: { option, code, detail }
    → cost.scoreOption() × 3 weight vectors
    → solve.partitionByZone()          only above SOLVER_ZONE_PARTITION_THRESHOLD
    → solve.buildPlan() × 3            → allocation.solveAssignment() → hungarian()
  ← three plans, timedOut, unplannedJobIds; NOTHING has been written
  → commit/persistSolverRun.persistSolverRun()
  no feasible option? → api/escalation.ts → domain/escalationCard.buildEscalationCard()

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
