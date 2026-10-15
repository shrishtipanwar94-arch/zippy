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

## GOTCHAS — things already discovered the hard way

**An upsert on a JOIN TABLE is append-only, not idempotent.** `upsert({ where,
update: {}, create })` on `technician_capability` or `unit_capability` adds a
link and never removes one. A fixture that grants capabilities this way keeps
every capability any earlier version of that fixture granted, because
`zippy_test` persists between runs. Phase 13 lost most of an afternoon to it:
two test files each granted the same scarce capability pair, one file's crew
silently kept a capability from a previous edit, and each file's jobs were
being served by the other file's units. Any fixture that OWNS a set — rather
than adding to one — must `deleteMany` the links first and then grant. The
same applies to any seeder or route that means "these are the capabilities"
rather than "add this capability".

**A test fixture competes with the seeded fleet.** `buildDispatchSnapshot`
reads the WHOLE fleet, not one zone, so all 24 seeded units are candidates for
every job in every test. Distance does NOT isolate a fixture: OSRM snaps a
coordinate to the nearest node in its graph, so with a single-city extract (Delhi
now; it was Bengaluru when this was found) a job 1500km away still comes back
adjacent to a local van. Isolate by
required capabilities instead, and make two fixtures' requirement sets
DISJOINT rather than merely rare — there is only one non-tow capability pair no
seeded crew holds, so two files both reaching for "something scarce" will
collide.

**In a shared test database, never assert a raw table count.** `zippy_test` is
shared by every suite and vitest runs files in parallel, so any assertion
phrased about the whole database drifts the moment another test — or a panel,
or a sweep — writes concurrently. Phase 14 hit it exactly: the invariant-2 test
proved "the solver writes nothing" by counting rows in eight tables before and
after, which was true and only checkable while nothing else was writing; adding
a suite that wrote decision records turned it red for a reason that had nothing
to do with the solver. Assert only on rows the test itself created or can
uniquely identify — invent an id prefix and count `WHERE id LIKE 'mytest-%'`.
The scoped version is usually the STRONGER claim too: counting rows that cannot
exist unless the code under test created them proves something about that code
specifically, rather than about the database being quiet.

**A globally side-effecting FUNCTION is the same hazard as a raw count.** The
rule above is usually read as being about assertions, and it is not: it is
about scope. `retryPendingAuthorisations` sweeps every pending payment in the
database, and two suites called it — so whichever ran first authorised the
other's row, and the loser asserted against a backlog somebody else had
cleared. `runPayoutBatch` pays every technician above the minimum, and its
batch reference is the DAY, so two suites running a payout on the same
simulated date share one batch row. Both failed roughly one run in ten and both
had passed for two phases; adding test files at Phase 17 widened the
interleaving enough to expose them. If a test calls something that operates on
"everything", either scope the call (an optional `jobIds` filter the production
caller does not pass) or scope every assertion about its effects to the rows
the file created. Asserting on the function's own return count is the trap:
that number is always about the whole database.

The same rule applies to fixtures competing for a shared row. Once
`decision_records` gained a unique index on `(job_id, solver_run_id)`, every
selection test sharing one solver run made the first test to run the only one
that could write. Each test that needs to make a decision now creates its own
run.

**A future-dated fixture squats permanently on a "newest N" list.** `GET /jobs`
returns the fifty newest, and `ownership` and `tenancy` each assert a
dispatcher's list contains their own jobs, created at `now()`. A fixture dated
in 2032 outranks `now()` in every run that will ever happen, so it holds one of
those fifty slots forever. Phase 15c had forty-nine such jobs — two money suites
had picked future years for their price-list windows, and one of them created
jobs through real intake that could not be cleaned up afterwards because
`job_events` is append-only. Adding four more jobs per run tipped two unrelated
suites red. Date every fixture in the PAST, and if a test must create jobs it
cannot delete, age them at the start of the next run.

**A rejected Bash tool call may still have run.** The rejection text is written
for the Edit/Write case, where the harness performs the write and can decline
to. A Bash command that was already executing cannot be unwound: check the disk
before assuming a change did not land.

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

## Phase workflow — review anchor per phase

START OF EVERY PHASE — before writing any code for Phase N, cut a review-base
branch at the current HEAD:

  git branch pre-phaseN <current HEAD>

This exists so `/code-review ultra pre-phaseN` reviews only that phase's diff.
`/ultrareview` with no base tries to diff the whole repo — there is no `main`
on GitHub — and refuses once the diff crosses its size limit, which is exactly
what happened at the Phase 22 ship point. The branch is a diff anchor only,
never a place to land commits; all phase work commits to `master`. Delete it
once the phase is reviewed, or keep it if the next phase reuses the same
anchor. The review itself is billed and user-triggered — the assistant cannot
launch it.

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
 ### What broke
  Real errors, dead ends and surprises hit during this phase, why they
  broke, and how they were fixed. "Nothing broke" is valid. Never invent
  difficulty.
### Hard rules
1. Never document as implemented what is not implemented.
2. No textbook explanations. Name actual files, tables, functions.
3. Never hide a weakness. §15 is the most valuable section.
4. Never claim measured performance or traffic that does not exist.
5. Preserve useful content; correct contradictions rather than keeping both.
6. Announce updates in one line at most.
