# Codemap

Where things live, the order to read them in, and the call paths that matter.
Refreshed at the same checkpoints as INTERVIEW.md (Phases 4, 9, 13, 17, 22). Current through Phase 22.

## 1. Where things live

```
src/index.ts                web process: app + Socket.IO on one HTTP server
src/worker.ts               worker: saga recovery, THEN queues, THEN health loop

src/api/app.ts              builds the app and mounts every router
src/api/solve.ts            POST /solve — snapshot, solve, persist, several plans
src/api/intake.ts           POST /jobs/intake[/describe]; next-question; answers
src/api/diagnosis.ts        POST /jobs/:id/diagnosis — the on-site re-diagnosis
src/api/actions.ts          GET /actions; execute a RECOMMEND; approve an APPROVE
src/api/console.ts          dispatcher board: timeline, decision, scarcity, queue
src/api/driver.ts           GET /jobs/:id/driver-view — every sentence, server-worded
src/api/technician.ts       offers, the status ladder, the completion code
src/api/stock.ts            van stock, confirmations, a parts declaration
src/api/vehicles.ts         POST /vehicles — registration, tenant off the token
src/api/fleet.ts            GET /fleet/dashboard — a fleet manager's own numbers
src/api/chat.ts             messages, promotions, who may confirm which kind
src/api/estimates.ts        estimate, approval, capture — the money surface
src/api/escalation.ts       GET/POST /jobs/:id/escalation — the no-plan handover
src/api/chaos.ts            the break-it panel; mounts NOTHING in production
src/api/health.ts           GET /health — dependencies AND the degradation ladder
src/api/middleware/         authenticate (bearer + RBAC gate); errors, one place
src/auth/                   JWT pair, argon2id, role -> resource -> action, tenant scope
src/infra/config.ts         env parsed once through Zod; process exits if invalid
src/infra/db.ts             prismaBase + both read-isolation extensions — use this
src/infra/routing.ts        OSRM /route and /table; haversine fallback; degraded flag

src/domain/                 small, single-purpose vocabulary files, one concept each:
  replanTriggers·actionTiers            eight triggers; AUTO/RECOMMEND/APPROVE
  faultRules·questionSelection·capabilitySet   naive-Bayes classify(); info gain; skills needed
  hypothesisView·healthLadder·escalationCard·messageClassifier
                                         hypothesis shape; six health parts; code->card; chat->PROPOSAL
  stockConfidence·contractExposure·contractContention
                                         age; a breach priced as credit; a scarce unit two tenants wanted
  fleetSlaOutcome·fleetMetrics·repeatPattern·fleetPrior   the fleet dashboard's math
  workshopAcceptance·workshopHours      betaAcceptMean — counter + conjugate prior, no ML; isWorkshopOpen (IST)
  money·ledger·pricing·coverage         paise, double entry, contract caps
  (also) entropy, safety, faults, symptoms, geo, carriageway, wording, prompts
src/engine/                 zero imports from prisma or redis, every file here
  candidates.ts                     builds (unit, technician) options; snapshot types
  partSourcing.ts                   where a part comes from — ONE answer PER PAIR
  destinationSelection.ts           where a tow goes — ONE answer PER JOB, not per pair
  feasibility.ts                    eleven hard filters, first match wins, reason codes
  cost.ts                           eight weighted terms, four vectors; durations.ts feeds it
  ranking.ts                        invariant 4's lexicographic comparator — safety above cost
  allocation.ts                     the Hungarian algorithm by hand; padding; UNAVAILABLE_COST
  solve.ts                          THE ORCHESTRATOR — hash, plans, safety bands, deadline
src/commit/                  the only place any of this writes
  dispatchSnapshot.ts               the ONE place a snapshot is read out of Postgres
  persistSolverRun.ts               the only write in the solve path
  holds.ts                          version-checked unit holds; release is idempotent
  offers.ts                         technician offers: PROPOSED -> ACCEPTED|DECLINED|TIMEOUT
  saga.ts                           three-leg reservation, compensations in reverse
  sagaRecovery.ts                   startup: commit ALL_ACCEPTED, compensate everything stale
  redispatch.ts                     handleTrigger + executeReassignment
  destinationAcceptance·contractTerms·contention   real outcome->one count; sla pinned at intake; a contention card, never a decision
  vanStock·stockMovements·partsConsumption         the parts write path
  vehicleRegistration·fleetIncidents·fleetDashboard   one vehicle one tenant; the fleet numbers' one query
  eventPromotions.ts                a flagged message becomes a job change — with a human
  estimates·payments·ledger·payouts the money write path
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
src/workers/offerExpiry.ts  a technician offer's deadline; the destination leg shares it
src/workers/notification.ts driver replan (90s) and fleet state-change (10min), one queue
src/realtime/publish.ts     THE fan-out point — Server or Redis emitter, nothing else
src/realtime/server.ts      handshake JWT, rooms, suppressLiveUpdates for chaos
evaluation/runner.ts        the discrete-event loop; a hidden trueFault drives re-dispatch
evaluation/ai/              108 labelled descriptions, a keyword control, six metrics
scripts/simulate-200-offers.js   the Phase 22 check: 200 fabricated destination offers
prisma/                     85 tables, append-only triggers, version columns; the seed
tests/concurrency/          REAL Postgres via testcontainers — holds, offers, mutation
public/js/                  one state object; panels render(state); per-role page wiring
```

## 2. Reading order

1. `src/infra/config.ts` — nothing runs without valid env.
2. `src/api/app.ts` — how a request is wrapped and which routers exist.
3. `src/infra/db.ts` and its two extensions — read before any query, or the `where` clauses in routes look dangerously incomplete.
4. `src/intake/createJob.ts` — a breakdown becomes a job in one transaction, pinning the price list, settlement path and sla policy it settles under; read with `realtime/outbox.ts`, since the retry and the publish-after-commit rule only make sense as a pair.
5. `src/ai/extractSymptoms.ts` — the AI's whole footprint: it fills in the form step 4 consumes, and every failure lands on the picker.
6. `src/api/solve.ts` — the dispatch entry point, short on purpose.
7. `src/engine/solve.ts` — **the orchestrator; read this before the parts.**
8. `src/engine/candidates.ts` — what an option is, and the snapshot types; then `partSourcing.ts` (per pair) and `destinationSelection.ts` (per job) for the two decisions resolved INSIDE candidate generation — the second reads `domain/workshopAcceptance.ts`'s whole learned-P(accept) formula.
9. `src/engine/feasibility.ts` — invariant 3 in code: filters with reason codes.
10. `src/engine/cost.ts` with `durations.ts` — the objective function; then `ranking.ts` for invariant 4 and `allocation.ts` for the assignment.
11. `src/commit/holds.ts` — the conditional UPDATE that IS the concurrency argument, written longhand for that reason.
12. `src/commit/saga.ts` then `sagaRecovery.ts` — three legs, compensation in reverse, and what a crash leaves behind.
13. `src/domain/replanTriggers.ts` and `actionTiers.ts` — the policy tables, read before `src/commit/redispatch.ts`, which applies them.
14. `src/domain/healthLadder.ts` with `src/health/loop.ts` — what the system does when a piece of it is missing, and how it notices.

## 3. Call paths

```
POST /solve                                              (a job being dispatched)
  → api/solve.ts             requirePermission('read','solverRun')   DISPATCHER
  → chaos/switches.isChaosOn('SOLVER_TIMEOUT') → deadlineMs          [ edge only ]
  → commit/dispatchSnapshot.buildDispatchSnapshot(prismaBase)
  → engine/solve.solve()
    → candidates.generateCandidates()  → infra/routing.travelTimeMatrix()  [ OSRM ]
        → partSourcing (per PAIR) · destinationSelection (per JOB, not per pair)
    → feasibility.checkFeasibility()   → rejected: { option, code, detail }
    → cost.scoreOption() × N weight vectors
    → solve.partitionByZone()          only above SOLVER_ZONE_PARTITION_THRESHOLD
    → solve.buildPlan() × N            → one Hungarian PER SAFETY BAND → hungarian()
  ← several plans, timedOut, unplannedJobIds; NOTHING has been written
  → commit/persistSolverRun.persistSolverRun()
  → commit/contention.raiseContentionApprovals()     cross-tenant, APPROVE, never decided
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
                 impact carries destinationWorkshopId, if this is a tow
  ← technicianOutcome: WAIT | RELEASE_PENDING

a saga compensating                                      (any leg fails)
  → saga.advanceSaga() → compensateSaga()      ← state RELEASED_ALL
    leg 3 → destinationOffer WITHDRAWN; recordAcceptanceOutcome() if resolved
    leg 2 → technicianOffer WITHDRAWN + JobEvent; an ACCEPTED technician gets 'TECHNICIAN_RELEASED_AFTER_ACCEPT' — already driving
    leg 1 → holds.releaseHold()    conditional; a second call is a no-op
    → finishAsRequeued()           REQUEUED + 'DISPATCH_REQUEUED'
  entered from: recordTechnicianDecision · recordDestinationDecision · offerExpiry (shares one deadline) · sagaRecovery (startup)
```
