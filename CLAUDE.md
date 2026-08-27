## Project
Zippy — breakdown dispatch optimised for time-to-resolution, not arrival.

## Invariants — never violate these
1. Postgres is the source of truth for every hold and reservation.
   Redis is cache and queues only.
2. The solver never writes to the database. Pure function over a snapshot.
   All mutation goes through /src/commit.
3. Hard constraints are filters with reason codes, never numeric penalties.
4. Safety level is a lexicographic ordering ABOVE the cost function.
5. The LLM classifies and extracts. It never decides.
6. Every compensation is idempotent.
7. One active job per unit. No multi-stop routing.
8. Every degraded state is visible to an operator.
9. Concurrency is tested against a real Postgres, never mocked.
10. NO EXTERNAL API IN THE DISPATCH DECISION PATH. Anything the solver,
    feasibility engine or cost function depends on must be local and
    deterministic, or the evaluation harness stops being reproducible.
    External services belong at the edges — intake, notifications,
    payments — never inside a decision.

## Stack — locked
TypeScript strict · Node 20 · Express · PostgreSQL 16 + Prisma · Redis 7 +
BullMQ · Socket.IO · Zod · Vitest + Supertest + testcontainers.
Frontend: HTML + Bootstrap 5 + vanilla JS + Leaflet + morphdom, static from
/public. NO bundler, NO framework, NO build step.
Routing: self-hosted OSRM from Phase 6 — never a hosted maps API.
Deployment: one platform, one origin, two always-on processes.

## Conventions
- /src/engine has zero imports from prisma or redis.
- Every state transition writes a JobEvent.
- Every external-facing mutation takes an idempotency key.
- Errors are typed. No `any`. Forward slashes in all paths.
- Secrets live in .env only. Never commit one, never log one.

## READABILITY CONTRACT — the maintainer must be able to explain every line

This project exists to be defended in an interview. Code the maintainer
cannot read aloud and explain is worse than no code. Optimise for
explainability over elegance, every time.

WRITE
- Explicit over clever. A named intermediate variable beats a chained
  one-liner. `const feasible = options.filter(isFeasible)` beats a pipeline.
- Plain functions taking plain objects. Classes only for genuine state
  machines.
- One concept per file. If a file needs a paragraph to explain what it does,
  split it.
- Files under ~200 lines. Functions under ~40. If either grows past that,
  the shape is wrong.
- Comments that say WHY, never WHAT. "Conditional update because two
  dispatchers can race here" — not "// update the unit".
- Boring names. `calculateExpectedResolutionTime`, not `computeETR`.
- Early returns over nested conditionals.
- One obvious way to do each thing. If there are two paths to the same
  outcome, delete one.

DO NOT WRITE
- No dependency injection frameworks, decorators, or metaprogramming.
- No generic type gymnastics — conditional types, mapped types, infer.
  A slightly wider type the maintainer understands beats a precise one
  they cannot read.
- No abstract base classes or inheritance hierarchies. Composition, or
  nothing.
- No premature abstraction. Two similar functions are fine. Extract only
  at the third repetition, and only if the abstraction is obvious.
- No barrel files re-exporting re-exports.
- No clever destructuring, nested ternaries, or `reduce` where a `for`
  loop reads better.
- No design patterns invoked by name unless the pattern is genuinely
  load-bearing (the saga is; a factory is not).

WHEN A PHASE INTRODUCES A CONCEPT THE MAINTAINER MAY NOT KNOW
Add a short comment block at the top of that file explaining the concept in
plain language and why this code needs it. Two or three sentences. Example:

  // OPTIMISTIC LOCKING
  // Two dispatchers can try to hold the same unit at the same moment. Rather
  // than locking the row (which would hold a transaction open while we wait
  // on a technician's phone), we update conditionally on the version we
  // read. If someone else got there first the version changed, zero rows are
  // affected, and we know we lost the race.

That comment is what the maintainer will read the night before an interview.
Write it for that reader.

## docs/CODEMAP.md — maintain this alongside INTERVIEW.md

The maintainer did not type this code and needs to be able to find their way
around it. Maintain docs/CODEMAP.md, updated at the same checkpoints as
INTERVIEW.md (end of Phases 4, 9, 13, 17, 22).

It contains three things and nothing else:

1. WHERE THINGS LIVE — one line per directory and per significant file.
   src/engine/candidates.ts   builds (unit, technician) options for a job
   src/engine/feasibility.ts  hard filters, returns reason codes
   src/commit/saga.ts         the three-leg reservation, with compensations
   Plain language. No file listed without a purpose.

2. READING ORDER — the numbered path through the codebase for someone
   trying to understand it from scratch. Start at the entry point, follow
   one real request end to end, then the engine, then the commit path.
   Say WHY each step comes where it does:
     1. src/index.ts        — how a request enters
     2. src/api/jobs.ts     — the intake route, start here to follow a job
     3. src/domain/...      — what a job actually is
     4. src/engine/solve.ts — the orchestrator; read this before the parts
     ...
   Ten to fifteen steps maximum. If it needs more, the codebase is too
   tangled and that is the real finding.

3. CALL PATHS for the three flows that matter — a job being dispatched, a
   diagnosis changing, a saga compensating. Each as a short chain of file
   and function names, no prose:
     POST /jobs/intake → intakeService.create() → faultRules.classify()
       → solverQueue.add() → solve.run() → candidates.generate()
       → feasibility.filter() → cost.score() → allocation.assign()
       → saga.propose()

Keep it under 150 lines. A map longer than the territory is not a map.

## INTERVIEW.md — standing instruction
This repo contains INTERVIEW.md, a living SDE interview-prep document for the
maintainer. You maintain it, silently. Never quiz, teach, or interrupt.

END OF EVERY PHASE — append ONE structured entry to DECISIONS.log. Do not
touch INTERVIEW.md. Template — length tracks what happened, no cap:
  ## Phase N — name / Date / Commit
  ### Built           files, tables, functions, endpoints by name
  ### Decisions       Decision / Why / Alternative / Why not / Tradeoff
  ### Concurrency     Scenario / What races / Why dangerous / How handled /
                      Assumption relied on
  ### Weaknesses introduced   and whether each matters at current scale
  ### Concepts now genuinely in use
  ### Interview angle 1-2 questions this makes answerable, in two sentences

AT CHECKPOINTS (end of Phases 4, 9, 13, 17, 22) — consolidate DECISIONS.log
into INTERVIEW.md, then clear it. Also refresh docs/CODEMAP.md so the map,
the reading order and the call paths match the current code. Edit in place, never append duplicates.
§13 Decisions · §9 Concurrency · §15 Weaknesses · §14 questions only if the
code can answer them · §17 resume claims only if implemented and, for
numbers, measured · §19 rewritten every time.

### Hard rules
1. Never document as implemented what is not implemented.
2. No textbook explanations. Name actual files, tables, functions.
3. Never hide a weakness. §15 is the most valuable section.
4. Never claim measured performance or traffic that does not exist.
5. Preserve useful content; correct contradictions rather than keeping both.
6. Announce updates in one line at most.
