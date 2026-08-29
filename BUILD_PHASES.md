# Zippy — All Phases

**One file. Everything you need.** Each phase has the prompt to paste, the check to run, and the two commands to close it out. You don't need any other document to build this.

---

## The loop, every phase

```
1. paste the prompt into Claude Code
2. run the Check commands
3. break it on purpose, confirm the test catches it, revert
4. tell Claude Code:  log this phase in DECISIONS.log
5. git commit
```

**Never skip step 3.** A test that has never failed is decoration. Stash your work, introduce the bug the test exists to catch, watch it go red, revert.

## Stop points

- **After Phase 17** — core complete, already a defensible project
- **After Phase 22** — recommended ship point, ~9 weeks
- **Phases 23–26** — first thing to cut if time runs out

## Windows notes

- Use `curl.exe`, not `curl` (PowerShell aliases it to something else)
- `&` doesn't background a process — open a second terminal tab
- Install jq once: `winget install jqlang.jq`
- Database shell: `docker compose exec postgres psql -U postgres -d zippy`

---

## API keys — what YOU need to get, and when

**You create these, not Claude Code and not me.** Secrets never go in a chat and never go in git. They live in `.env`, which is gitignored from Phase 0.

| Key | Needed at | Where | Cost |
|---|---|---|---|
| **LLM API key** (Anthropic or OpenAI) | **Phase 16** | console.anthropic.com or platform.openai.com | a few dollars for the whole build — one small call per intake |
| Razorpay **test** keys | Phase 22b, optional | dashboard.razorpay.com → Settings → API Keys → **Test Mode** | free, no real money moves |
| Deployment platform account | Phase 26 | Railway / Render / Fly | ~$10–20/month |
| Sentry DSN | Phase 26, optional | sentry.io | free tier |

**That's the whole list — one required key for the entire core build.** Everything else is self-hosted on purpose:

- Routing: **OSRM**, local, no key (Phase 6)
- Map tiles: **OpenStreetMap** via Leaflet, no key
- Database, queues: Docker locally, managed at Phase 26
- Auth: yours

Rules, and they matter:

```
.env            real values, GITIGNORED, never committed, never pasted anywhere
.env.example    placeholder values only, committed
```

If a key ever lands in a commit, rotate it — deleting the line does not remove it from git history. And **nothing before Phase 16 needs any key at all**, so you can build for weeks without signing up for anything.

---

## Testing — what runs where

There is no separate testing document. Every phase has a **Check** block, and that is the test plan. But the shape is worth knowing up front:

| Kind | Runs | Command |
|---|---|---|
| **Unit** — engine logic | pure functions, no DB | `npm run test` |
| **Integration** — routes, auth | Supertest against the app | `npm run test` |
| **Concurrency** — invariants | **real Postgres via testcontainers** | `npm run test:concurrency` |
| **Evaluation** — policy comparison | seeded replay, imports production engine | `npm run eval` |
| **AI eval** — extraction quality | labelled set, offline | `npm run eval:ai` |
| **Load** — where it breaks | autocannon, Phase 25 | `npx autocannon ...` |

Two rules that carry the whole thing:

**Concurrency tests never use mocks.** If `npm run test:concurrency` finishes in under a second, no container started and the tests prove nothing.

**Break it on purpose, every phase.** Stash, introduce the bug the test exists to catch, watch it go red, revert. A test that has never failed is decoration.

---
---

# PHASE 0 — Foundation

*Code, CLAUDE.md, INTERVIEW.md, DECISIONS.log and docs/ — all created here.*

````
Set up a new project called Zippy.

Zippy is a roadside breakdown dispatch system. Thesis: optimise expected
time-to-RESOLUTION, not time-to-arrival. The nearest technician often cannot
fix the fault — sending them is fast to arrive and slow to resolve. This
phase builds the foundation and the project documentation. No domain logic.

════════ PART A — CODE ════════

## Structure
  /src/api /src/domain /src/engine /src/commit /src/workers /src/infra
  /prisma /public /evaluation /tests /docs /requests

## Stack — locked, do not substitute
  TypeScript strict, Node 20, ESM
  Express, serving static files from /public — no bundler, ever
  Prisma + PostgreSQL 16
  Redis 7 + BullMQ
  Zod
  Vitest + Supertest + testcontainers

## Two processes from the start
  src/index.ts   → web    (Socket.IO added at Phase 4)
  src/worker.ts  → worker (BullMQ added at Phase 5)
The worker can be an empty loop that logs and stays alive. It must exist as
its own process now.

## npm scripts — exactly these names
  dev / dev:worker      tsx watch src/index.ts | src/worker.ts
  start / start:worker  node dist/index.js | dist/worker.js
  build / typecheck     tsc | tsc --noEmit
  test / test:watch     vitest run | vitest
  test:concurrency      vitest run tests/concurrency
  lint                  eslint src
  db:migrate/db:deploy  prisma migrate dev | deploy
  db:seed               tsx prisma/seed.ts
  db:reset              prisma migrate reset --force
  db:studio             prisma studio
Install tsx. Scripts with nothing to run must still exist and exit cleanly.

## Infrastructure
docker-compose.yml: postgres:16 and redis:7, healthchecks, named volumes.
src/infra/config.ts: env through a Zod schema. The process REFUSES TO START
  on a missing or malformed variable. Include PUBLIC_URL, WS_ORIGIN and
  CORS_ORIGINS now even though they are localhost today.
Structured JSON logging (pino), request id on every line.
GET /health running SELECT 1 on Postgres and PING on Redis, returning
  { status, db, redis, uptime }. Never a hardcoded 200. Dependency down →
  503, process STAYS ALIVE.
.gitignore (node_modules, dist, .env) · .env.example with placeholders only ·
.gitattributes with `* text=auto eol=lf`
/requests/health.http — a VS Code REST Client file, so API calls are
  version-controlled rather than living in a separate app.

════════ PART B — CLAUDE.md ════════

```markdown
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
```

════════ PART C — DOCUMENTATION ════════

## docs/STACK.md
Every locked choice with the alternative rejected and a one-sentence defence:
- PostgreSQL over MongoDB — version-checked conditional updates,
  transactional saga legs, an append-only ordered event log, a relational
  domain. Mongo needs a replica set for multi-document transactions.
- Modular monolith over microservices — /src/engine has no DB imports, so
  allocation is a pure function over a snapshot, testable without
  infrastructure and importable by the harness.
- No frontend build step — value is backend; the discipline React would
  enforce is enforced by hand: one state object, one render(state) per panel.
- Two processes from day one — they deploy separately and fail differently.
- Optimistic over pessimistic locking — low contention, and pessimistic locks
  would be held across an external actor's response time.
- Self-hosted OSRM over a hosted maps API — determinism; an external routing
  call makes seeded replay non-reproducible.
Plus a "do not relitigate" list: Postgres→Mongo, Express→Nest, vanilla→React,
monolith→services, Redis holds, Kafka, Supabase, a second frontend host.

## docs/DEPLOYMENT.md
- ONE platform, ONE origin, TWO always-on processes (web, worker) plus
  managed Postgres and Redis.
- No free tier that sleeps — the simulator, queues and WebSocket connections
  must stay up. A spun-down Zippy is an empty board.
- No separate frontend host. A split does not fix a cold start (that lives in
  the API and WebSocket, not the HTML) and serverless cannot hold persistent
  WebSocket connections.
- Migrations run on release. Seed idempotent. Scheduled reset every 4 hours,
  announced in the UI. Four demo accounts, dispatcher featured.
- LLM: per-IP rate limit plus a global daily token budget that trips DEGRADED
  mode. The resilience fallback is also the cost ceiling.
- The rule everything serves: an interviewer opening the link cold sees
  something interesting within thirty seconds, without clicking.

## docs/UI.md
Three surfaces, three different jobs. A design brief later phases follow.

VISUAL DIRECTION — the genre is Indian roadside-assistance services: clean,
high-contrast, card-based, one obvious action per screen, no stock
photography, no hero imagery of people. Take the GENRE, not any brand. Zippy
uses its own name, palette and copy. Never reproduce another company's logo,
colours or wording.

Palette: hazard amber accent against a neutral slate base. Define it once as
CSS custom properties in /public/css/tokens.css and use those variables
everywhere — no hardcoded hex in panel code.
  --accent (amber, primary actions and live status) · --danger (red, reserved
  for HIGH_RISK and failures) · --ok (green, only confirmed/resolved) ·
  --surface, --surface-alt, --text, --text-muted, --border
Never use colour as the only signal — pair it with a label or icon.

DRIVER — mobile-first, calm, one action per screen. The person is stressed,
possibly at night, on a roadside. Large type, generous tap targets, short
sentences, no jargon, no enums ever. Status is a sentence, not a badge. The
live ETA and the technician's identity reduce anxiety most — make them the
largest elements.

TECHNICIAN — field use. Big tap targets, very high contrast for daylight,
glanceable. Accept/decline with a visible countdown. One obvious primary
button at a time. Assume one-handed use and a cracked screen.

DISPATCHER — desktop control room, dense. Information density is the goal,
not whitespace. Small type, tabular, dark surface, many live regions. This is
the surface an interviewer looks at; it should read as an operations console,
not a consumer app.

MECHANICS: Bootstrap 5 via CDN. One state object, one render(state) per
panel, nothing else touches the DOM. Patch table rows by data-job-id; never
rebuild a table on every event or you lose scroll position during the demo.

## docs/CODEMAP.md
Where things live, the reading order, and the call paths — as described in
CLAUDE.md. Small for now; it grows at every checkpoint.

## INTERVIEW.md
Nineteen sections, filled in HONESTLY for the state after this phase. Most
say "not implemented" and that is correct — do not pad them.
  1 Project Overview · 2 Architecture · 3 Request Lifecycles · 4 Database ·
  5 API Design · 6 Auth · 7 Backend Concepts Used · 8 Engineering Problems ·
  9 Concurrency · 10 Failure Handling · 11 Security · 12 Scaling ·
  13 Design Decisions & Tradeoffs · 14 Interview Questions ·
  15 Things An Interviewer Can Attack · 16 How I Would Improve It ·
  17 Defensible Resume Claims · 18 Technical Vocabulary ·
  19 Current Project State
§7 lists about five concepts — only what this phase uses.
§13 carries the decisions from docs/STACK.md.
§15 starts with "the project is barely built".
§17 must say: currently NONE.

## DECISIONS.log
Header explaining the cadence, then the Phase 0 entry using the template,
based on what you actually built.

════════ DO NOT ════════
- no authentication, no domain models beyond the health check
- no frontend pages yet, no bundler, no CI, no README
- no optimisation library, no maps API, no OSRM yet (Phase 6)
- do not invent anything for INTERVIEW.md that you did not build
- do not reproduce any real company's branding, logo, colours or copy
````

**Check:**
```powershell
npm run                                   # all 15 scripts
docker compose up -d
npm run dev                               # second tab for the next line
curl.exe -s localhost:3000/health | jq
docker compose stop postgres
curl.exe -s localhost:3000/health | jq    # db down, PROCESS STILL ALIVE
docker compose start postgres
```
Open `INTERVIEW.md`: §7 should list ~5 concepts, §17 must say none are defensible. If either is inflated, tell Claude Code it overclaimed.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 0: foundation and docs"`

---

# PHASE 1 — Schema and seed

*Every table exists. Seed data makes dispatch decisions non-trivial.*

````
Design the Prisma schema for Zippy. Create every model below, including ones
nothing reads yet — later phases depend on them existing now.

CORE       User(role DRIVER|TECHNICIAN|DISPATCHER|FLEET_MANAGER), Driver,
           Vehicle, VehicleProfile, Technician, TechnicianShift, Capability,
           TechnicianCapability, Unit, UnitCapability, UnitStatusHistory, Zone
INCIDENT   Job, JobEvent, SymptomReport, FaultHypothesis, IntakeQuestion,
           IntakeAnswer, LocationEvent, EtaEstimate, CompletionVerification
DISPATCH   DispatchOption, PlanVariant, DispatchOffer, UnitHold,
           TechnicianOffer, SolverRun, DecisionRecord
INVENTORY  Part, PartCategory, UnitStock, StockMovement, StockConfirmation,
           Depot, RestockOrder                       (unread until Phase 18)
PRICING    PartPrice, LabourRate, TowTariff, CalloutFee, PriceList
           (prices are versioned with validFrom/validTo — a job prices
            against the list in force at CREATION, never re-priced later)
MONEY      Payment, PaymentEvent, Authorisation, Capture, Refund,
           Estimate, EstimateLine, EstimateApproval,
           LedgerAccount, LedgerEntry, Commission, Payout, PayoutBatch,
           CashCollection, ContractBilling          (unread until Phase 15c)
PROVIDERS  Workshop, WorkshopCapability, WorkshopAuthorisation, WorkshopHours,
           DestinationOffer, AcceptanceOutcome
TENANCY    Tenant, TenantMembership, Contract, ContractTier, SlaPolicy,
           CoveredService                            (unread until Phase 20)
CONTROL    ActionRequest, ApprovalRecord, Escalation, EscalationDecision,
           SystemHealthState
COMMS      Conversation, Message, MessageDelivery, Attachment, EventPromotion,
           Notification
CROSS      SlaEvent, AuditLog, IdempotencyKey, AiExtraction

Requirements:
- JobEvent is append-only. No updates, no deletes — enforce it in the database.
- Every row that can be raced (Unit, Job, UnitStock) has a `version` Int.
- IdempotencyKey scoped per user, with a TTL index.
- Money in integer paise. Never Float.
- LedgerEntry is append-only, like JobEvent. No updates, no deletes. A
  correction is a new compensating entry, never an edit.
- Every LedgerEntry has a signed amount and a account_id. The invariant that
  must ALWAYS hold: for any transaction id, the entries sum to zero.
- Anything originating outside the system records both eventTime and
  receivedAt — external events arrive late and duplicated.
- Index for queries that will actually run: units by zone+status, jobs by
  status+createdAt, events by jobId+sequence.

Then prisma/seed.ts producing a realistically hard board:
- 6 zones over a plausible city geography
- 24 units: van, bike, flatbed tow, wheel-lift tow
- 31 technicians with an UNEVEN capability matrix — scarcity is the point:
    EV high-voltage certification: exactly 2
    key programming: 3
    OBD diagnostics: 18
    basic jump/tyre/fuel: all
- shifts that overlap only partially
- 12 workshops with brand authorisations, EV class flags, hours
- ~20 parts with per-unit stock levels and prices
- a price list: labour rate per hour, tow tariff per km, callout fee
- 4 tenants: 1 GOLD fleet, 2 SILVER fleets, walk-in consumers

Seeding must be idempotent — safe to run twice.

DO NOT
- no API routes, no business logic
- do not seed uniformly. Uneven capability is the entire point.
````

**Check:**
```powershell
npm run db:reset; npm run db:seed; npm run db:seed   # twice, no error
docker compose exec postgres psql -U postgres -d zippy
```
```sql
SELECT c.name, COUNT(*) FROM technician_capability tc
JOIN capability c ON c.id = tc.capability_id GROUP BY c.name ORDER BY 2;
-- EV certification must show 2. If everything is 25-31, the seed is uniform
-- and every scarcity scenario later is meaningless.

UPDATE job_events SET event_type='HACKED' WHERE id=(SELECT id FROM job_events LIMIT 1);
-- must be REJECTED
```

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 1: schema and seed"`

---

# PHASE 2 — Auth, RBAC, tenant scoping

*Four roles. Tenant isolation enforced twice.*

````
Add authentication and authorisation to Zippy.

- JWT access + refresh. argon2id password hashing.
- Four roles: DRIVER, TECHNICIAN, DISPATCHER, FLEET_MANAGER.
- A permission table in code (not scattered if-statements) mapping
  role → resource → action, behind a single can(user, action, resource).

TENANT SCOPING — enforce at TWO layers. Single-point enforcement is how
cross-tenant leaks happen:
  1. Middleware attaches tenantId to the request context.
  2. A Prisma extension injects a tenantId filter into every query on a
     tenant-scoped model. A query that forgets its scope returns NOTHING,
     never everything.

DISPATCHER may read across tenants. Every cross-tenant read writes AuditLog.

Tests:
- each role can do exactly what the permission table allows and no more
- a FLEET_MANAGER querying another tenant's job gets 404, not 403 — do not
  leak existence
- a query on a tenant-scoped model without scope returns empty
- the cross-tenant dispatcher read writes an audit row

DO NOT
- no OAuth, social login, password reset emails
- no UI, no rate limiting yet
````

**Check:**
```powershell
npm run test -- rbac tenancy
```
Then break it: strip the tenant filter from one query and re-run. The Prisma extension must still return nothing. If another tenant's rows come back, you have a leak.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 2: auth and tenancy"`

---

# PHASE 3 — Intake

*Question count varies with ambiguity. The simulator is a production component.*

````
Build the intake pipeline for Zippy. No AI yet — a deterministic stand-in.

1. SYMPTOM CAPTURE
POST /jobs/intake takes a structured symptom payload (engine cranks
yes/no/unsure, warning lights, unusual sounds) and produces a FaultHypothesis:
a probability distribution over fault types plus a required-capability set.
Compute it from a hand-written rule table in src/domain/faultRules.ts.
Phase 16 replaces the INPUT (free text via LLM), never this structure.

2. ENTROPY-DRIVEN QUESTION SELECTION — the part that matters
Given the current distribution, choose the next question that maximally
reduces Shannon entropy over fault types. This is expected information gain:
for each candidate question, for each possible answer, compute the posterior
and its entropy, weight by P(answer), pick the lowest expected posterior
entropy. PURE CALCULATION — no LLM call. Deterministic, cheap, testable.
Stop when entropy falls below a threshold, or the required-capability set is
stable across the top-K faults, or a question cap is hit.
Expose GET /jobs/:id/next-question.
The number of questions MUST vary with ambiguity: "flat tyre" asks zero,
"won't start" asks about three.
Log entropy before and after each answer so this is measurable later.

3. SAFETY TRIAGE
Highway vs local, traffic speed, blocking a live lane, smoke or burning
smell, fuel smell, overheating, night, driver alone, vulnerable passengers.
Produces SafetyLevel NORMAL | ELEVATED | HIGH_RISK on the Job.
Nothing consumes it yet.

4. LOCATION REFINEMENT — a feasibility input, not a UX nicety
lat/lng, direction of travel, nearest exit or km marker, landmark,
position (SHOULDER|LANE|SERVICE_ROAD|PARKING), parking level.
Carriageway direction is first-class — a unit on the wrong side of a divided
highway is 20km away by road.

5. SIMULATOR — REQUIRED. Not optional, not a dev convenience.
Phase 10's evaluation harness replays seeded scenarios through this. No
simulator means no harness, no measured result, and nothing defensible to
put on a resume. It also keeps the deployed board alive, since a deployed
dispatch system has no real callers.
The deployed instance runs it continuously so the dispatch board is never
empty. Build it properly now; retrofitting an autonomous mode at Phase 26
costs a week you will not have.
- configurable arrival rate, fault mix, safety distribution
- DETERMINISTIC given a seed (Phase 10 depends on this)
- runs as a one-shot script OR a long-lived worker loop with a kill switch
- leave clean extension points for later phases to drive other actors:
  technicians accepting with realistic latency and decline rate, diagnoses
  changing on arrival, stock depleting. Stub them now.

Every step writes a JobEvent.

DO NOT
- no LLM call anywhere in this phase
- no dispatch, allocation, or assignment
- no UI
- do not let intake choose a service type — the backend decides later
````

**Check:**
```powershell
npm run sim -- --rate 40 --duration 60
npm run sim -- --seed 123 --duration 60      # run twice, identical output
```
```sql
SELECT j.id, COUNT(ia.id) AS questions FROM jobs j
LEFT JOIN intake_answers ia ON ia.job_id=j.id GROUP BY j.id;
-- flat tyre → 0, won't start → ~3. Same number for both = form wizard, not
-- entropy-driven.

SELECT entropy_before, entropy_after FROM intake_answers ORDER BY created_at;
-- mean information gain across all answers must be positive; individual
-- rows may increase entropy and that is correct
```

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 3: intake"`

---

# PHASE 4 — Walking skeleton ⭐ CHECKPOINT

*Three actors on live state. Do it now, not in week eight.*

````
Wire Socket.IO through Zippy end to end, with the crudest possible UI.

- Socket.IO server, JWT verified ON THE HANDSHAKE, not after connect.
- Rooms: per-job (driver + assigned technician + dispatchers), per-zone
  (dispatchers), per-tenant (fleet managers).
- ONE event fan-out point: every JobEvent write publishes to the right rooms.
  One code path, no scattered emits.
- Reconnect with a lastEventSequence cursor so a dropped client replays what
  it missed, in order.

FRONTEND — vanilla JS + Bootstrap 5, NO build step. Static files served by
Express from /public. Bootstrap, morphdom and Leaflet via CDN link tags.

THE ONE DISCIPLINE — establish it now and never break it:
  /public/js/state.js       a single client-side state object. The WebSocket
                            handler updates state and calls render().
                            NOTHING else touches the DOM.
  /public/js/panels/*.js    one render(state) per panel. Idempotent.
  For busy tables, patch rows by data-job-id rather than rebuilding.
  Rebuilding on every event destroys scroll position and selection, which
  looks broken during a demo when jobs arrive every few seconds.
  Use morphdom where targeted patching would be fiddly.

Three deliberately ugly pages (Bootstrap defaults, zero styling effort):
  /driver /technician /dispatcher

Assignment for now: dispatcher picks a unit from a dropdown. Placeholder,
deleted at Phase 9.

DO NOT
- do not design anything
- do not add a bundler, framework, or build step
- do not set innerHTML on a whole panel on every event
- do not build allocation logic
- WebSocket first; polling is the Phase 17 fallback, not the mechanism
````

**Check:** three browser windows, three roles. An action in one appears in the others within a second. DevTools → Offline 10s → Online: missed events replay in order; duplicates are possible by design and the client ignores sequences it has already applied. In the console, `document.querySelectorAll('[data-job-id]').length` must be > 0.

**⭐ This is a checkpoint.** Also say: `consolidate DECISIONS.log into INTERVIEW.md`

**Close:** `git commit -m "phase 4: walking skeleton"`

---

# PHASE 5 — Redis and BullMQ

*Background work exists before anything depends on it.*

````
Add Redis and BullMQ to Zippy, in the worker process.

Queues: solver · offer-expiry (delayed) · notification (with coalescing) ·
cleanup (expired holds, stale idempotency keys)

- Every processor is idempotent. Re-running must not duplicate effects.
- Exponential backoff with a cap. Dead-letter queue for terminal failures.
- Graceful shutdown: in-flight jobs finish or requeue, none lost.
- A debounce helper for the solver queue — many triggers in a window collapse
  into one run. A re-plan storm is a real failure mode.
- Bull Board at /admin/queues, dispatcher-only.

INVARIANT 1: Redis holds queues and cache. It NEVER holds a reservation.
Unit holds live in Postgres.

DO NOT
- do not put any hold, reservation, or lock in Redis
- do not add Kafka
````

**Check:**
```powershell
node scripts/enqueue-100.js
# kill the worker at ~50, restart it
```
```sql
SELECT COUNT(*), COUNT(DISTINCT idempotency_key) FROM job_processing_log;
-- both must be 100
```
```powershell
docker compose exec redis redis-cli KEYS '*hold*'    # MUST be empty
```

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 5: queues"`

---

# PHASE 6 — Candidate generation

*Where all the hard work lives.*

````
Build candidate generation in src/engine/candidates.ts.

Input: a Job (with FaultHypothesis) plus a snapshot of units, technicians,
shifts, zones. Output: DispatchOption[] where DispatchOption =
{ unitId, technicianId, estimatedTravelMinutes, coveredFaultProbability,
  missingCapabilities[] }

For each (unit, technician) pair that could conceivably serve the job:
- resolve capability (technician skills ∩ unit capabilities)
- compute what fraction of the fault probability mass the pair can resolve
- compute travel time RESPECTING carriageway direction
- emit at most ONE option per pair

CRITICAL — put this as a comment at the top of the file:
  Parts sourcing (Phase 19) and destination selection (Phase 22) will be
  resolved INSIDE this function, collapsing to a single best choice per pair.
  The assignment matrix must never grow beyond jobs × (unit, technician).
  If a future change would add a dimension to the matrix, it belongs here
  instead.

This module has ZERO imports from prisma or redis. It takes a snapshot object
and returns options. Pure function.

ROUTING — add self-hosted OSRM before computing any travel time.

Add an osrm service to docker-compose.yml plus a one-time setup script that
downloads an OpenStreetMap extract for a single city and runs the OSRM
preprocessing pipeline (extract, partition, customise). Pick one city and
seed all zones inside it.

src/infra/routing.ts wraps the OSRM table/route endpoints and returns road
travel time between two points, respecting direction of travel.

WHY OSRM AND NOT A HOSTED MAPS API — invariant 10: an external routing call
makes seeded replay non-reproducible. Two runs of `npm run eval` with the
same seed would return different travel times, which destroys the one claim
the project rests on. OSRM is local, free, unlimited, needs no API key, and
returns identical answers every time.

It also makes carriageway direction real rather than hand-waved. A unit on
the opposite side of a divided highway is 20km away by road while 200m away
as the crow flies — Euclidean distance cannot express that, and
ACCESS_RESTRICTION depends on it.

Fallback: if OSRM is unreachable, use haversine × a configurable road-factor
and mark the estimate DEGRADED and visible to the operator (invariant 8).
Never silently substitute straight-line distance.

DO NOT
- do not filter infeasible options here (Phase 7)
- do not compute cost here (Phase 8)
- do not touch the database from this module
- do not use Google Maps, Mapbox, or any hosted routing API
````

**Check:**
```powershell
npm run test -- candidates
Select-String -Path src/engine/*.ts -Pattern "@prisma|ioredis"   # MUST be empty
```
✅ Option count equals the number of (unit, technician) pairs. ✅ Broad-capability technician shows higher covered probability than the nearest. ✅ Two points either side of a divider produce a road time far larger than the straight-line time. ✅ Stop the OSRM container → travel times fall back to haversine and are flagged DEGRADED, not silently wrong.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 6: candidate generation"`

---

# PHASE 7 — Feasibility

*Hard filters with reason codes. The codes are worth more than the filter.*

````
Build src/engine/feasibility.ts.

In: DispatchOption[] and the job.
Out: { feasible: DispatchOption[], rejected: { option, code, detail }[] }

Implement and test EVERY code:
  CAPABILITY_MISSING           technician lacks the skill
  VEHICLE_TYPE_INCOMPATIBLE    bike unit cannot tow a car
  NO_TECHNICIAN_ON_SHIFT       shift ends before the job could complete
  SLA_UNREACHABLE              cannot arrive within the window
  UNIT_UNAVAILABLE             on a job, in maintenance, offline
  ACCESS_RESTRICTION           basement level, opposite carriageway
  PART_UNAVAILABLE             (stub until Phase 19)
  NO_DESTINATION_AVAILABLE     (stub until Phase 22)
  DESTINATION_NOT_AUTHORISED   (stub until Phase 22)
  TENANT_CONTRACT_EXCLUDES     (stub until Phase 20)

INVARIANT 3: these are FILTERS. Do not implement any as a large numeric
penalty. A penalty big enough to act as a constraint is a constraint with a
latent bug — some combination of other terms eventually outweighs it and the
system dispatches an uncertified technician to an EV.

The rejected list is a first-class output, not debug logging. It renders in
the "Why this technician?" panel at Phase 14. Persist it on the SolverRun.

DO NOT
- do not implement any constraint as a penalty
- do not silently drop options — every rejection carries a code
- do not touch the database from this module
````

**Check:** `npm run test -- feasibility` — one passing test per code, ten total. An EV job with no certified technician produces `CAPABILITY_MISSING` in **rejected**, not a high-cost feasible option.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 7: feasibility"`

---

# PHASE 8 — Cost function

*The thesis, in code.*

````
Build src/engine/cost.ts.

cost = w1·expectedTimeToResolution + w2·travelDistance
     + w3·capabilityShortfallRisk + w4·slaRisk + w5·operationalCost

expectedTimeToResolution is the differentiating term:
  Σ over faults: P(fault) × [ travel + diagnose(fault)
                            + (canResolve ? resolve(fault)
                                          : escalation(fault)) ]
escalation models a real second dispatch — wait for a new unit, its travel,
its resolve time. NOT a flat penalty. The whole argument is that this term is
computed, not guessed.

capabilityShortfallRisk = Σ P(fault) × cannotResolve(fault)

Return a structured CostBreakdown, not a scalar. Every term is stored on the
DecisionRecord and rendered in the UI. A bare number is unexplainable.

SAFETY — INVARIANT 4. NOT a term in this function. A lexicographic comparator
wrapping the ranking:
  if job.safetyLevel === HIGH_RISK → order by arrival time first
  else → order by cost
A HIGH_RISK job orders by arrival regardless of every cost term.

FAIRNESS: not in this function. Measured as a secondary outcome at Phase 10.

Three named weight vectors: FASTEST_RESOLUTION, LOWEST_COST, BALANCED.

DO NOT
- no fairness in the cost function
- no safety as a weight in the cost function
- no hard constraints here
````

**Check:**
```powershell
npm run test -- cost
Select-String -Path src/engine/cost.ts -Pattern "fairness|gini|earnings|safety"
# must be empty
```
✅ The 7km broad-capability unit beats the 2km jump-starter-only unit on expected resolution. ✅ Flip to HIGH_RISK → ranking reverses. ✅ Change a weight → ranking changes.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 8: cost function"`

---

# PHASE 9 — Allocation ⭐ CHECKPOINT

*Global assignment. The Phase 4 dropdown dies.*

````
Build src/engine/allocation.ts.

Implement the Hungarian algorithm YOURSELF — no scipy, munkres or OR-Tools.
The point is that you can explain it. Cost matrix of pendingJobs ×
feasibleDispatchOptions. Handle the rectangular case by padding with a large
but finite dummy cost, and comment on why that padding is not a disguised
constraint.

Then src/engine/solve.ts:
  1. snapshot state
  2. generate candidates (Phase 6)
  3. filter feasible (Phase 7)
  4. score (Phase 8)
  5. run Hungarian once per weight vector → PlanVariant A, B, C
  6. persist a SolverRun: input snapshot hash, all three plans, rejected
     options with reason codes, per-option cost breakdowns, wall-clock
  7. return the plans. WRITE NOTHING ELSE.

INVARIANT 2: the solver does not mutate unit, technician or job state.

Zone partitioning above a configurable option count. Log when it happens and
comment the known approximation: a job near a zone boundary can lose a better
cross-zone option. Phase 10 measures how often that costs anything.

Delete the manual unit dropdown from Phase 4. The dispatcher now sees three
plans.

DO NOT
- no external solver library
- the solver writes nothing
- no reservations yet
````

**Check:**
```powershell
npm run test -- allocation
npm run eval -- --scenario capability-scarcity --policies nearest,global
Select-String -Path package.json -Pattern "or-tools|munkres|scipy"  # empty
```
✅ Global fulfils a job that nearest strands. ✅ A test asserts the solver performs zero database writes.

**⭐ Checkpoint.** Also say: `consolidate DECISIONS.log into INTERVIEW.md`

**Close:** `git commit -m "phase 9: allocation"`

---

# PHASE 10 — Evaluation harness ⭐ THE PROJECT

*The table that is your entire pitch. Built now, so every later layer arrives with a measured before-and-after.*

````
Build the evaluation harness in /evaluation.

CRITICAL: it MUST import the production modules from src/engine — candidates,
feasibility, cost, allocation. A parallel implementation proves only that your
simulator agrees with itself. This is the most important requirement here.

  /evaluation
    scenarios/   seeded, fully deterministic
    policies/    fifo | nearest-unit | skill-aware | capability-aware-global
    runner.ts    discrete-event simulation loop
    metrics.ts
    report.ts

Scenarios: normal-day · monsoon-surge (180 jobs, 24 units) ·
capability-scarcity (3 simultaneous EV calls, 2 certified technicians) ·
ambiguous-diagnosis · technician-dropout

Metrics: firstVisitResolutionRate · meanTimeToArrival · meanTimeToResolution ·
secondDispatchRate · slaBreaches · unitUtilisation · earningsGini (measured,
never optimised) · solverWallClockP95

Output a markdown table to stdout and write EVALUATION.md.

HONESTY REQUIREMENT: if a policy loses on a scenario, the report prints the
loss. Do not add filtering, weighting or scenario selection that flatters
global. A losing row is a stronger interview artifact than a fabricated win.

Add a sweep mode varying job volume, capability scarcity and technician
density, reporting whether the result holds across the sweep or only at one
operating point.

Scripts: eval, eval:sweep, eval:scenario.

DO NOT
- do not reimplement feasibility or cost inside the harness
- do not tune weights to win
- do not hide losing scenarios
````

**Check:**
```powershell
npm run eval -- --scenario monsoon-surge --seed 48291 > a.txt
npm run eval -- --scenario monsoon-surge --seed 48291 > b.txt
Compare-Object (Get-Content a.txt) (Get-Content b.txt)   # MUST be empty
Select-String -Path evaluation/*.ts -Pattern "src/engine"  # must find matches
```
✅ Nearest has the **best** arrival time and a **worse** resolution time than global. That inversion is your project.
✅ At least one scenario where global does not win, present and reported. If global wins everything, go find the scenario where it loses.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 10: evaluation harness"`

---

# PHASE 11 — Holds and real concurrency ⭐

*Two dispatchers cannot take one unit. Proved against a real database.*

````
Build unit holds and technician offers in src/commit.

UnitHold — created by a conditional UPDATE with a version check:
  UPDATE units SET status='HELD', version=version+1
  WHERE id=$1 AND status='AVAILABLE' AND version=$2
Zero rows affected means you lost the race. Handle that path explicitly.
Has a TTL; the cleanup worker releases expired holds.
Release is IDEMPOTENT — releasing twice is a no-op, not an error and not a
double-free.

TechnicianOffer — PROPOSED → ACCEPTED | DECLINED | TIMEOUT. TTL via the
offer-expiry queue. An accept arriving as the offer expires resolves to
exactly one outcome, never both.

Use parameter binding in the hand-written SQL. Never string interpolation.

CONCURRENCY TESTS — INVARIANT 9. Real Postgres via testcontainers. Not mocks,
not your dev database — these must be reproducible on someone else's machine.
Fire simultaneously with Promise.all:
  1. two dispatchers hold the same unit      → exactly one succeeds
  2. technician accepts as the offer expires → exactly one outcome
  3. release called twice                     → unit freed once
  4. hold expires mid-commit                  → commit fails cleanly
  5. 50 concurrent holds on 10 units          → exactly 10 succeed

Add a test that deliberately removes the version check and asserts the suite
catches the double-booking. Keep it skipped in CI but present in the repo — it
is the proof the tests are load-bearing.

DO NOT
- do not mock the database in these tests
- do not put any hold in Redis
````

**Check:**
```powershell
npm run test:concurrency        # must take >1s — a real container starts
```
Then the mutation test, and do this one properly:
```powershell
git stash
# delete "AND version = $2" from the hold query
npm run test:concurrency        # test 1 MUST fail
git checkout .; git stash pop
```
❌ Still passing means your tests run sequentially, not concurrently, and prove nothing.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 11: holds and concurrency"`

---

# PHASE 12 — The reservation saga ⭐

*Three parties. Compensations in reverse. Partial commit handled.*

````
Build the reservation saga in src/commit/saga.ts.

Comment at the top of the file:
  This is a saga, not 2PC. External actors (a technician's phone, a workshop's
  dispatcher) cannot be enrolled in a Postgres transaction, so failure
  handling is compensation, not rollback.

Legs:
  1. Unit hold          local, version-checked (Phase 11)
  2. Technician offer   external actor: accept / decline / timeout
  3. Destination offer  external actor, tows only — stub the workshop side
                        until Phase 22

State machine:
  PROPOSED → AWAITING_LEGS → ALL_ACCEPTED → COMMITTED
  any leg fails → RELEASED_ALL → REQUEUED

- Compensations run in REVERSE order of acquisition.
- Every compensation is idempotent.
- PARTIAL COMMIT is the important case: technician ACCEPTED, destination
  DECLINED. Both legs release, the job requeues, and the technician gets an
  explicit release notification rather than being left holding a dead
  assignment.
- Saga state is persisted. A startup routine finds non-terminal sagas and
  either completes or compensates them.

DO NOT
- do not attempt two-phase commit
- do not use a distributed transaction coordinator
- do not let a failed saga leave a unit held
````

**Check:**
```powershell
npm run test -- saga
# then manually: start a dispatch, kill the process between leg 2 and leg 3,
# restart
```
```sql
SELECT id, state FROM dispatch_offers WHERE state NOT IN ('COMMITTED','REQUEUED');
SELECT COUNT(*) FROM units WHERE status='HELD';
-- first returns nothing, second returns 0
```
❌ A unit stuck in HELD after restart means the recovery routine doesn't exist.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 12: reservation saga"`

---

# PHASE 13 — Re-dispatch and action tiers ⭐ CHECKPOINT

*The signature feature. The technician arrives and the diagnosis changes.*

````
Build re-dispatch and action tiering.

DIAGNOSIS CHANGE — POST /jobs/:id/diagnosis (technician only)
  → recompute required capabilities
  → can the assigned unit still resolve?
      YES → continue, update ETA, notify driver
      NO  → re-solve. The current technician either waits (if useful to the
            new plan) or is explicitly released.
  → every branch writes JobEvents and drives the driver's live view

RE-SOLVE TRIGGERS — define them in ONE place, src/domain/replanTriggers.ts:
diagnosis changed · technician declined · technician offline · unit breakdown
· destination declined · driver moved materially · safety level changed ·
job cancelled

THRASH CONTROL — you will be asked about this:
- debounce triggers within a window (Phase 5 helper)
- a job may not be reassigned more than N times without escalating
- a re-solve producing the same assignment is a no-op, not a churn event
- log every re-solve with its trigger so thrash is measurable

ACTION TIERS — ActionRequest rows with tier, reason, computed impact and
resolution. Not scattered if-statements.
  AUTO       execute immediately, log it (ETA notification, expired hold)
  RECOMMEND  reason + impact + cost shown; dispatcher clicks execute
  APPROVE    blocked pending sign-off, approver recorded

DO NOT
- do not let an AUTO action do anything a human would want to review
- do not re-solve on every GPS ping
````

**Check:** three windows. Technician changes diagnosis to something the assigned unit can't handle. ✅ Driver screen updates with a sentence, not a status code. ✅ Old technician explicitly released.
```powershell
node scripts/fire-10-triggers-fast.js
```
```sql
SELECT COUNT(*) FROM solver_runs WHERE created_at > now() - interval '1 minute';
-- 1 or 2, not 10
```

**⭐ Checkpoint.** Also say: `consolidate DECISIONS.log into INTERVIEW.md`

**Close:** `git commit -m "phase 13: re-dispatch"`

---

# PHASE 14 — Dispatch console

*Build in this order. The map is last and it's the one to cut.*

````
Build the dispatcher console. Order matters.

1. LIVE INCIDENT TIMELINE — the JobEvent stream rendered. Filterable by job,
   zone, event type.

2. "WHY THIS TECHNICIAN?" INSPECTOR — for any assignment, render the
   DecisionRecord: selected option with cost breakdown term by term, covered
   fault probability, and REJECTED alternatives each with its feasibility
   reason code. Nearly free — the data already exists from Phases 7 and 8 —
   and it is the highest-value screen in the product.

3. CAPABILITY SCARCITY PANEL — live counts. EV certified 1/31, flatbed 3/24,
   OBD 18/31. Amber and red thresholds. Makes the coupled constraint visible.

4. COMPETING PLANS — A/B/C side by side with metrics. Dispatcher selects.
   Manual override requires a reason code, recorded.

5. LIVE MAP — Leaflet + OpenStreetMap via CDN, no API key. Markers updated
   IN PLACE from the state object; never re-create the map or marker layer on
   an event. Do this LAST — most time, least insight.

6. PRIORITY QUEUE — safety level first (lexicographic), then SLA risk, then
   age.

DO NOT
- do not start with the map
- do not add charts, animations, or a design system
- do not build fleet or technician views yet
````

**Check:** click any assignment → cost breakdown term by term, plus rejected alternatives with reason codes. Then run the simulator at 40 jobs/hour for two minutes, scroll halfway down the table, and wait. ✅ Scroll holds, no flicker. ❌ Either failure means a panel is blasting innerHTML — fix it now, not at Phase 25.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 14: dispatch console"`

---

# PHASE 15 — Driver and technician surfaces

*Three actors on one live state. The driver never sees an enum.*

````
Build the driver and technician apps.

DRIVER
- request flow: symptoms → safety triage → location refinement
- "what we think it is and who's coming", in plain language:
  "We aren't certain whether it's the battery or the alternator, so we're
   sending someone equipped for both."
- live tracking with a real ETA, not a countdown timer
- HUMAN-READABLE STATE — a translation map, zero new backend:
    PLANNED      → Finding someone equipped for this
    COMMITTED    → Ravi is on the way, arriving 21:24
    DIAGNOSING   → Ravi is checking what's wrong
    REPLANNING   → Ravi found the battery isn't the problem. We're arranging
                   a tow to a workshop that can repair this.
    AWAITING_DESTINATION → Confirming a workshop that can take your car
    UNSERVICEABLE → We can't reach you tonight — here's what we're doing
- while-you-wait panel driven by safety level. Guidance must be GENERIC and
  CONSERVATIVE: "Hazard lights on. Move away from moving traffic if safe."
  Never diagnostic, never predictive about the vehicle. This is not an
  emergency-advice engine.
- itemised estimate BEFORE the completion code is entered
- completion verification code

TECHNICIAN
- job offers with a visible countdown, accept/decline
- status ladder: en route → arrived → diagnosing → working → complete
- diagnosis update (triggers Phase 13)
- completion code entry
- OFFLINE QUEUE: actions taken offline are queued with client-generated
  idempotency keys and replayed IN ORDER on reconnect. Replaying twice must
  not double-transition anything.

DO NOT
- do not show a raw state enum to a driver anywhere
- do not make the guidance card situation-specific
- do not build chat yet
````

**Check:** open the driver view and read it as a stranger. Any SCREAMING_CASE word is a bug. Then: DevTools offline → four technician actions → online.
```sql
SELECT COUNT(*), COUNT(DISTINCT idempotency_key) FROM technician_actions WHERE job_id='<id>';
-- both 4, applied in original order
```

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 15: driver and technician"`

---

# PHASE 15b — Chat and event promotion

*Unstructured information becomes operational state — with a human in the loop.*

````
Build chat for Zippy. It exists for one reason: roadside incidents contain
information no intake form can anticipate. "I'm on the service road, not the
highway." "There's a divider between me and the technician."

SCOPE IT TIGHTLY
Conversation, Message, MessageDelivery, Attachment. WebSocket delivery,
Postgres durable history, one photo attachment, a "Send my exact location"
action sending coordinates.
NO typing indicators. NO read receipts. That is where messaging balloons.

MESSAGE → OPERATIONAL EVENT PROMOTION — INVARIANT 5
  1. A classifier flags a message as possibly containing operational
     information (location correction, access restriction, safety change,
     diagnosis detail). Rule-based for now.
  2. A HUMAN CONFIRMS. Who depends on what it is:
       safety changes → THE DRIVER confirms, one tap. The dispatcher is the
       wrong person and three minutes too slow.
       location and access → technician or dispatcher
  3. On confirmation, write the event with provenance back to the message id.
  4. The event may trigger a re-solve.

NEVER auto-parse a message into a state change. A message silently rewriting
a dispatch location is how a technician is sent to the wrong place with no
audit trail.

SAFETY CONFIRMATION (driver side):
  "Are you blocking moving traffic?
   This changes how we prioritise your job — we'll send whoever can reach
   you fastest."          [ Yes ]  [ No ]
On Yes: SafetyLevel → HIGH_RISK → priority escalates → objective flips to
minimise-arrival → dispatch re-ranks. Flag aggressively; let the driver
dismiss. False negatives are the dangerous direction.

COALESCED NOTIFICATIONS: a re-plan can fire six events in ninety seconds. The
driver receives ONE message, after the plan stabilises, not mid-flight.

DO NOT
- do not auto-apply any promotion
- do not add typing indicators or read receipts
- do not send more than one notification per re-plan
````

**Check:** send "I'm on the service road, not the highway" as the driver. ✅ Flagged, and **nothing changes** until someone confirms. Then send "we're blocking the left lane" → tap Yes → watch the assignment actually re-rank.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 15b: chat and promotion"`

---

# PHASE 15c — Money domain ⭐

*Pricing, estimates, payment, and the technician earnings ledger. Marketplace model — the driver pays through the app, the platform takes commission, the technician gets paid out.*

````
Build the money domain for Zippy. NO real gateway in this phase — a
PaymentProvider interface with a StubProvider that always succeeds and a
FailingStubProvider for tests. Phase 22b swaps in Razorpay behind the same
interface. The settlement rules are business logic and must be testable
without a vendor.

════ 1. PRICING ════

PartPrice, LabourRate, TowTariff, CalloutFee, all under a versioned
PriceList with validFrom/validTo.

A job prices against the list IN FORCE AT JOB CREATION and is never
re-priced. Store the priceListId on the Job. This is the same rule as
contract terms at Phase 20 and for the same reason: the customer agreed to
one set of numbers.

════ 2. ESTIMATE AND APPROVAL ════

Estimate + EstimateLine, generated after diagnosis:
  Diagnosis   Alternator failure
  Parts       Drive belt (unit stock)     ₹640
  Labour      1.0h @ ₹800                 ₹800
  Tow         4.2km @ ₹214/km             ₹900
  ─────────────────────────────────────────────
  Total                                 ₹2,340
  Covered by contract (GOLD)            −₹900
  Payable                               ₹1,440

RE-APPROVAL LOOP — the technician finds more work than the approved estimate
covers. This is a real flow, not an edge case:
  - a revised estimate exceeding the approved total by more than a
    configurable tolerance requires a NEW driver approval
  - work PAUSES at AWAITING_APPROVAL — it does not continue optimistically
  - the driver may approve, decline (job completes at the approved scope),
    or cancel (Phase 15c cancellation policy applies)
  - every approval is recorded with what was approved and when

════ 3. PAYMENT — three settlement paths, decided by contract ════

  FLEET TENANT (GOLD/SILVER)  invoiced monthly. NO gateway. ContractBilling.
  CONTRACT CONSUMER           covered, zero payable. NO gateway. The driver
                              still sees the estimate with the deduction.
  WALK-IN CONSUMER            authorise, then capture. Gateway path.

Resolve the path at job creation from Contract and CoveredService, store it
on the Job, never recompute.

THE TWO-STAGE SPLIT — you cannot charge the full amount before dispatch,
because you do not know it. The fault is unknown; it may be a ₹640 belt or a
₹2,340 alternator plus tow.

  COMMIT      → AUTHORISE the callout fee only. Fixed, known, small.
  DIAGNOSIS   → estimate generated, driver approves
  COMPLETION  → the verification code is what TRIGGERS capture. The
                technician enters it, and that single action means
                "service delivered" and releases the capture. Capture the
                approved total; if it exceeds the authorisation, a second
                authorisation is required — handle it, do not truncate.
  CANCELLED   → void, or capture only what the policy says

CANCELLATION POLICY — a pure function in src/domain/cancellationPolicy.ts,
unit-testable with no database:
  before technician accepts   → void everything, no charge
  accepted, not en route      → void, no charge
  en route                    → capture callout fee only
  on scene                    → callout fee + parts consumed

════ 4. THE LEDGER — this is the marketplace part ════

Double-entry. LedgerAccount per technician, per platform revenue line, and a
cash-in-transit account.

THE INVARIANT THAT MUST ALWAYS HOLD:
  for any transactionId, SUM(LedgerEntry.amount) = 0
Assert it in a test after EVERY money operation. This is the single most
rigorous testable property in the project — a ledger that balances is
checkable, and a ledger that does not is a bug you can prove.

LedgerEntry is APPEND-ONLY. A correction is a new compensating entry, never
an edit. Same rule as JobEvent, same reason.

On job completion, one transaction with balanced entries:
  technician earnings          +₹1,872   (job total − commission)
  platform commission          +₹468     (20%, configurable per contract)
  customer receivable          −₹2,340

CASH COLLECTION — the case that makes this interesting, and it is most of
the volume in India. If the driver pays the technician in cash:
  technician cash-owed         −₹468     (they now OWE the platform its
                                          commission)
  platform commission          +₹468
The technician's balance can go NEGATIVE. Payouts must handle a negative
balance by netting it against future earnings, never by transferring a
negative amount. Test this explicitly — it is the non-obvious case.

CANCELLATION COMPENSATION also writes ledger entries: a technician who drove
out and was cancelled on is owed something. That is why the saga's
compensation path calls the money domain, and why that call must be
idempotent (invariant 6).

════ 5. PAYOUTS — computed here, executed at Phase 22b ════

PayoutBatch, computed on a schedule (daily), per technician:
  balance = SUM(ledger entries for that account)
  skip if below a configurable minimum
  skip if negative — net against future earnings instead
  create a PayoutBatch in PENDING; Phase 22b actually sends the money

════ 6. PAYMENT IS NEVER ON THE DISPATCH CRITICAL PATH — invariant 8 ════

A stranded driver does not wait for a card to clear. Authorisation failing
or the provider being unreachable means:
  - the job dispatches ANYWAY
  - payment state becomes PENDING_AUTHORISATION
  - the operator sees it, flagged
  - a retry worker attempts it later
Test this explicitly.

════ TESTS ════
- the ledger balances to zero after every operation — assert it in a helper
  used by every money test
- each of the three settlement paths resolves correctly from the contract
- capture exceeding the authorisation → second authorisation, not truncation
- partial capture → remainder voided
- cancel at each of the four stages → the policy function's exact outcome
- cash collection → technician balance goes negative → payout nets it
- provider unreachable at commit → job dispatches, payment PENDING, flagged
- double capture with the same idempotency key → captured once
- revised estimate over tolerance → work pauses at AWAITING_APPROVAL
- a price list expiring mid-job → the job settles at creation-time prices

DO NOT
- no real gateway, no API keys, no network calls in this phase
- do not let payment state gate any dispatch decision
- do not store card details, ever
- do not put cancellation or commission rules inline in the saga
- do not build GST, TCS, technician KYC, disputes or chargebacks — name them
  in docs as deliberate headroom
````

**Check:**
```powershell
npm run test -- money ledger cancellation
```
✅ The balance assertion runs after every money test and never fails.
✅ Cash collection drives a technician balance negative; the payout nets it rather than sending a negative amount.
✅ Kill the stub provider mid-dispatch → job still dispatches, payment `PENDING_AUTHORISATION`, operator sees the flag.
✅ A GOLD fleet job never calls the provider at all.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 15c: money domain"`

---

# PHASE 16 — GenAI

*Replace the input to Phase 3, not its structure. And measure whether the probabilities mean anything.*

````
Add LLM-based symptom extraction to Zippy.

IN: free text or voice transcript, typically mixed Hindi and English.
  "Bhai gaadi start nahi ho rahi, pehle ek khatakhat awaaz aayi thi aur ab
   dashboard pe battery ka light aa raha hai"

OUT: a Zod-validated FaultHypothesis, identical in shape to the one Phase 3's
rule table produces:
  { fault_distribution: { alternator: 0.40, drive_belt: 0.25, battery: 0.20,
                          starter: 0.10, other: 0.05 },
    required_capabilities: [...], required_parts: [...],
    tow_probability: 0.35, urgency_signals: [...], vehicle_context: {...} }

- Zod validation. Schema-invalid output retried once, then falls back.
- The driver confirms or corrects before dispatch.
- Store every extraction in AiExtraction with raw input, raw output, latency,
  and whether it validated. You need this for the metrics.
- The distribution must sum to 1. Normalise, and log when you had to.

EVALUATION — this is what stops the probabilities being decorative. Build
/evaluation/ai with at least 100 labelled symptom descriptions and report:
  top1Accuracy · top2Recall · expectedCalibrationError (ECE) ·
  schemaValidRate · fallbackRate · entropySecondDispatchCorrelation

That last one is the important one. If high-entropy predictions do NOT
correlate with higher second-dispatch rates, the entropy-driven hedging
policy is unjustified and you must report that.

FALLBACK — INVARIANT 8: LLM unavailable → the Phase 3 symptom picker takes
over and the system stays fully functional, with the degraded state visible.
AI improves intake. It is never on the correctness path.

Second, smaller job: classify whether a chat message contains operational
information (Phase 15b). Classification only. A human commits.

DO NOT
- no RAG, no multimodal
- the LLM never chooses a technician, a plan, or a service type
- no free-form explanations for the UI — the why-panel renders the decision
  record directly
````

**Check:**
```powershell
npm run eval:ai
$env:LLM_API_KEY="invalid"; npm run dev
```
✅ ECE is a real number, reported honestly. ✅ With a broken key, create a job → symptom picker appears → dispatch works end to end → DEGRADED banner shows.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 16: genai intake"`

---

# PHASE 17 — Chaos and degradation ⭐ CHECKPOINT — CORE COMPLETE

*The "break it" demo.*

````
Build chaos controls and degradation modes.

LADDER — every state visible to the operator, never silent:
NORMAL
DEGRADED
  AI unavailable        → structured symptom picker
  GPS stale             → last known position + manual entry, flagged
  WebSocket unavailable → client falls back to polling
  Solver timeout        → best incumbent, else nearest feasible, flagged
  Payment unavailable   → mark pending, never block dispatch
CRITICAL
  Core dispatch down    → manual dispatcher workflow, queue visible,
                          assignments by hand, all writes still audited

Persist the mode in SystemHealthState, render a banner in the console, and
transition automatically via a health-check loop that logs every transition.

CHAOS CONTROLS (dispatcher-only, dev/demo builds): toggle LLM · toggle Redis ·
toggle WebSocket · force solver timeout · take a technician offline · break a
unit mid-job · force a destination decline · inject N jobs.

HUMAN ESCALATION CARD — when no feasible plan exists, UNSERVICEABLE is not
the end state. The dispatcher gets: the reason with its specific feasibility
code, the closest option that WOULD work and why it was rejected, the
alternative, a recommendation, and actions (Approve / Find external provider
/ Contact driver).

Write CHAOS_TESTING.md documenting each control and what actually happens.

DO NOT
- no silent degraded states
- chaos controls must not exist in a production build
- CRITICAL is a defined manual workflow, not a crash
````

**Check:** toggle every control. ✅ Each degrades visibly and **recovers on its own** within a minute of switching back. A control that leaves the system stuck is the worst possible demo failure. ✅ Force UNSERVICEABLE → escalation card with a real reason code, not a blank screen.

**⭐ Checkpoint.** Also say: `consolidate DECISIONS.log into INTERVIEW.md`

**Close:** `git commit -m "phase 17: chaos and degradation"`

> ## ⏸ CORE COMPLETE
>
> **Stop here if time is short.** You have a capability-aware dispatcher with a saga-based commit protocol, a measured allocation policy, real-Postgres concurrency tests, and a designed degradation ladder.
>
> Before continuing: fill in the README benchmark table from a real `npm run eval` run, and rehearse the demo. **Do not start Phase 18 with numbers still saying TODO.**

---

# PHASE 18 — Parts and inventory

*Capability gains a time dimension.*

````
Add the parts model to Zippy.

  Part, PartCategory      catalogue
  UnitStock               per-unit quantity, with a version column
  StockMovement           append-only: CONSUMED | REPLENISHED | ADJUSTED,
                          each with an idempotency key
  StockConfirmation       a technician's declaration, timestamped
  Depot, RestockOrder

STOCK IS A CLAIM, NOT A FACT. Model confidence by age (thresholds
configurable):
  confirmed < 2h → VERIFIED · 2–8h → AGEING · > 8h → UNVERIFIED

Technician surface: van stock screen, "confirm stock" action, consumption
declaration on job completion.

Consumption is idempotent on movement id — a double tap, or an offline
replay, decrements once.

DO NOT
- do not wire parts into feasibility yet (Phase 19)
- do not allow parts to move between units — this is a cliff, see the spec
- do not build supplier procurement
````

**Check:** run a simulated shift.
```sql
SELECT s.id, s.starting_qty - SUM(m.qty) AS computed, s.current_qty
FROM unit_stock s JOIN stock_movements m ON m.unit_stock_id=s.id GROUP BY 1,2,3;
-- computed = current_qty for every row
```

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 18: parts"`

---

# PHASE 19 — Part-aware feasibility ⭐

*The phase that justifies the whole layer.*

````
Wire parts into the engine.

1. FEASIBILITY — implement PART_UNAVAILABLE for real.
   canResolve(option, fault) = hasSkill(fault) ∧ hasPart(fault)
   UNVERIFIED stock counts as UNAVAILABLE. FAIL CLOSED — assuming a part is
   present when it may not be produces a wasted dispatch, which is worse
   than a slightly conservative one.

2. CANDIDATE GENERATION — resolve part sourcing INSIDE generation.
   For each (unit, technician) pair, for each fault branch:
     in-van stock covers it         → cost 0, time 0
     a workshop run could supply it → cost + time of that detour
     neither                        → contributes to shortfall risk
   Keep the SINGLE BEST source per pair.

   THE MATRIX MUST NOT GROW. Add a test asserting option count still equals
   pair count. This is the answer you will be asked for: parts increase the
   richness of each option, not the dimensionality of the assignment.

3. COST — add partSourcingCost = detour time + part value.

4. NEW BRANCH: PART_SOURCING. Technician has the skill, not the part. The
   system prices a workshop run vs a second dispatch vs a tow IN THE SAME
   COST FUNCTION and picks. Driver sees: "Ravi has the skills but needs a
   part — we're arranging it."

5. EVALUATION — add the skill-aware policy (closest unit with the right
   SKILL, stock ignored) and a parts-stockout scenario. Report
   stockoutInducedFailures for every policy.

The result you want: skill-aware beats nearest and loses to stock-aware. That
single row justifies this phase. If it does not appear, report that too.

DO NOT
- do not add a part dimension to the assignment matrix
- do not allow cross-van part transfer
- do not treat UNVERIFIED stock as available
````

**Check:**
```powershell
npm run eval -- --policies nearest,skill-aware,global
npm run test -- candidates -t "option count"
```
✅ `stockoutInducedFailures`: nearest > skill-aware > global. ✅ Option count still equals pair count.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 19: part-aware feasibility"`

---

# PHASE 20 — Tenancy and contracts

*Contract SLA enters the objective. Safety still outranks it.*

````
Activate the tenancy layer. Tables exist from Phase 1, scoping from Phase 2.

  Contract        tenant, tier (GOLD|SILVER|BRONZE), validity window
  SlaPolicy       arrival SLA minutes, resolution SLA, breach penalty (paise)
  CoveredService  which services this contract covers

COST FUNCTION: add contractSlaExposure = P(breach) × penalty.
Comment why this belongs in the objective when fairness does not: a contract
breach is a quantified obligation with a defined cost. Earnings distribution
is a policy preference.

SAFETY STILL OUTRANKS CONTRACT TIER, lexicographically. A GOLD vehicle in a
car park does not outrank a consumer on a live carriageway. Test this
explicitly.

PLAN C: a third weight vector, PROTECT_CONTRACTS. When it deprioritises
consumer jobs the UI must SAY SO — a warning line on the plan card. The
trade-off is shown, never hidden.

CROSS-TENANT CONTENTION → APPROVE TIER. When one scarce resource is contested
by a contract job and a consumer job at the same safety level, the system
prices the trade-off and ESCALATES. It does not decide alone. A system that
silently chooses which paying customer to disappoint is a system nobody
deploys.

Tests:
- a contract expiring mid-incident → the job completes under the terms in
  force at creation, never re-priced mid-flight
- a vehicle registered to two tenants → rejected at registration
- HIGH_RISK consumer beats a GOLD contract job
- cross-tenant contention creates an APPROVE ActionRequest

DO NOT
- do not let contract tier override safety
- do not auto-resolve cross-tenant trade-offs
- do not add billing integration
````

**Check:** cross-tenant contention produces an APPROVE card with both costs priced. Flag the consumer HIGH_RISK → they win over GOLD.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 20: tenancy"`

---

# PHASE 21 — Fleet dashboard

*The fourth projection of the same event stream.*

````
Build the fleet manager surface.

- active incidents across the tenant's vehicles
- SLA met % this month, current exposure in rupees
- mean resolution time, spend
- per-vehicle incident history

REPEAT-PATTERN FLAG — highest value, least code. A recurrence rule over
incident history: "MH-04-7712 — 3rd battery incident in 60 days. Not a
dispatch problem. Flagged for your maintenance team."
It is a RULE, not a model. Label it as one in the UI and in INTERVIEW.md.
Do not turn it into predictive maintenance.

INTAKE PRIOR: a fleet vehicle arrives with known make, model, service history
and prior incidents, so intake starts from a sharper prior. Feed prior
incidents into the fault distribution before the first question is asked.

Notification coalescing for fleet managers uses a WIDER window than drivers —
they need state-change summaries, not sub-minute updates.

DO NOT
- no predictive maintenance model
- no cross-tenant visibility for fleet managers
- no exports, charts, or reporting beyond the numbers above
````

**Check:** a fleet vehicle with two prior battery incidents asks **fewer** intake questions than an unknown vehicle with identical symptoms.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 21: fleet dashboard"`

---

# PHASE 22 — Workshop network ⭐ CHECKPOINT — SHIP POINT

*A decline makes the next decision better.*

````
Build out the workshop layer.

  WorkshopAuthorisation   per brand, plus an EV class flag
  WorkshopHours           operating windows
  AcceptanceOutcome       every offer result: ACCEPTED | DECLINED | TIMEOUT,
                          with hour-of-day and vehicle class

LEARNED P(accept): estimate per (workshop, hour bucket, vehicle class) using
a Beta prior with counts from AcceptanceOutcome. No ML infrastructure — a
counter and a conjugate prior. Cold start falls back to the prior.

COST: add destinationRefusalRisk = (1 − P(accept)) × re-solve cost. The system
now prefers workshops that actually say yes.

FEASIBILITY: implement DESTINATION_NOT_AUTHORISED and NO_DESTINATION_AVAILABLE
for real. Brand authorisation and EV class are SEPARATE reason codes —
"authorised for Maruti but not for EVs" is a distinct and real failure.

CANDIDATE GENERATION: pre-screen destinations by authorisation and P(accept),
keep the top M. Again, the matrix does not grow.

UI: a destination screening panel in the why-inspector:
    Workshop A  ✕ P(accept) 0.31 at this hour
    Workshop B  ✓ P(accept) 0.87 · authorised for Maruti · 4.2 km

DO NOT
- do not model workshop bay capacity as a data feed — no such feed exists
- do not build a commercial provider scorecard
- do not add ML infrastructure
````

**Check:**
```powershell
node scripts/simulate-200-offers.js --workshop A --decline-evenings
```
```sql
SELECT hour_bucket, p_accept FROM workshop_acceptance WHERE workshop_id='A' ORDER BY 1;
-- evening p_accept measurably dropped, and evening ranking with it
```

**⭐ Checkpoint.** Also say: `consolidate DECISIONS.log into INTERVIEW.md`

**Close:** `git commit -m "phase 22: workshop network"`

> ## ⏸ RECOMMENDED SHIP POINT — ~9 weeks
>
> Core + parts + tenancy + workshops. A complete product. Update the README from a real eval run, rehearse the demo, deploy.
>
> **Phases 23–24 are the first thing to cut**, and cutting them costs nothing provided you describe coverage as deliberate headroom.

---

# PHASE 22b — Razorpay adapter

*Swap the stub for the real thing. The domain does not change.*

````
Implement the Razorpay provider behind the PaymentProvider interface built at
Phase 15c. TEST MODE ONLY. No real money will ever move through this.

The domain does not change. If any business rule needs editing to make
Razorpay fit, the Phase 15c abstraction was wrong — fix the interface, not
the rules.

Build:
- RazorpayProvider implementing authorise / capture / void / refund
- order creation, and a test-mode checkout on the driver surface
- POST /webhooks/razorpay with SIGNATURE VERIFICATION — reject unsigned or
  mis-signed payloads BEFORE parsing anything
- IDEMPOTENCY ON THE GATEWAY'S EVENT ID, kept separate from your client-side
  idempotency keys. Different concerns; conflating them is a bug.
- handle webhooks arriving OUT OF ORDER and TWICE. "Payment captured" can
  arrive before "order created".
- a reconciliation worker that periodically queries Razorpay for any local
  payment in a non-terminal state and settles it
- PAYOUTS: execute the PayoutBatch rows computed at Phase 15c via Razorpay
  Payouts (test mode). A payout is idempotent on the batch id. A failed
  payout returns the batch to PENDING and never double-pays. A negative
  technician balance is never sent — it nets against the next batch.

THE INTERESTING FAILURE — and the reason this phase is worth doing: the
gateway says SUCCESS and your database missed the write. That is the
dual-write problem with money on one side and a lost row on the other. The
reconciliation worker is the answer, and you should be able to explain why a
webhook alone is not.

Keys in .env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET —
all TEST mode. Never commit them. .env.example gets placeholders only.
For local webhook testing, expose localhost with ngrok and register that URL
in the Razorpay test dashboard.

DO NOT
- do not enable live mode
- do not store card details
- do not change any Phase 15c business rule to accommodate the vendor
- do not claim anywhere that this processed real payments
````

**Check:** replay one webhook three times → one payment row, one transition. Bad signature → rejected before parsing. Kill the app between gateway success and your DB write → the reconciliation worker settles it on restart. Run the Phase 15c test suite unchanged against the real provider — it must pass.

⚠️ **Resume wording:** *"Razorpay integration in test mode with signature-verified idempotent webhook handling and a reconciliation worker for gateway/database divergence."* Never "payment processing" — you processed nothing.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 22b: razorpay adapter"`

---

# PHASE 23 — Coverage engine

*It must write. A read-only dashboard fails the coherence test.*

````
Build the coverage engine. IT MUST WRITE — a coverage dashboard that only
reads fails the coherence test. Delete it and nothing else changes.

  ZoneDemandStat  rolling empirical incident rate per (zone, hour, weekday).
                  THIS IS NOT A MODEL. It is a bucketed average. Do not call
                  it demand prediction anywhere in code or UI.
  CoverageGap     zone × capability × severity
  RepositionRecommendation, RestockRecommendation
  RecommendationOutcome   EXECUTED | DISMISSED | EXPIRED | SUPERSEDED

Loop, every N minutes or on significant state change: forecast demand per
zone → compare against positioned capability → identify gaps → generate
candidate remedies → SCORE THEM IN THE SAME COST FUNCTION as dispatch → emit
the top K as RECOMMEND-tier ActionRequests.

ANTI-THRASH GUARDS — you will be asked about every one:
  minimum improvement  reduce projected expected resolution by ≥ a threshold,
                       not by ε
  cooldown             a unit repositioned in the last T minutes is ineligible
  hysteresis           reversing a recent reposition requires a strictly
                       larger improvement than the original
  cap                  at most K live recommendations; new ones SUPERSEDE
  in-flight exclusion  a unit on a job is never a candidate

UNIT STATE: add REPOSITIONING and RESTOCKING. A unit in REPOSITIONING is
STILL AVAILABLE for dispatch from its projected position. A repositioning
unit that cannot be interrupted by a real incident is a bug. Test it.

Record EVERY terminal outcome including dismissal. A recommendation system
that only logs its successes cannot be evaluated.

Concurrency: two dispatchers executing the same recommendation → exactly one
wins, the other sees SUPERSEDED. Real Postgres test.

DO NOT
- no demand prediction model
- no auto-executed repositioning
- a repositioning unit is never unavailable for dispatch
````

**Check:** oscillating demand does not make units ping-pong. Two dispatchers racing one recommendation → exactly one EXECUTED, one SUPERSEDED.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 23: coverage engine"`

---

# PHASE 24 — Coverage ablation

*Measure whether it helped. Report honestly either way.*

````
Add three configurations to the harness:
  coverage OFF · coverage ON auto-executed · coverage ON dispatcher-gated

Report: mean time to arrival · SLA breaches · repositioning km driven ·
thrash count (repositions reversed within the window) · recommendations
dismissed vs executed.

Add a THRASH PROBE scenario with deliberately oscillating zone demand and
assert units do not ping-pong.

REPORT THE RESULT HONESTLY. "I measured it and it did not help at this fleet
size" is a strong finding and almost no candidate has one. Do not tune the
guards until coverage wins. Write the finding into EVALUATION.md either way.
````

**Check:** the ablation produces a result you would show an interviewer regardless of which way it went.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 24: coverage ablation"`

---

# PHASE 25 — Verify and rehearse

````
Close out correctness and rehearse the demo.

1. Verify every failure case is implemented and tested:
   diagnostic uncertainty (3) · resource failure (3) · inventory failure (4) ·
   destination failure (4) · tenancy failure (3) · situation change (3) ·
   coordination failure (5)
   Every concurrency case against a REAL Postgres.

2. Observability: request tracing with correlation ids, solver duration
   histogram, saga outcome counters, queue depth, degraded-mode transitions.
   One dashboard page in the console.

3. Rehearse all ten signature scenarios LIVE, in order, from a clean seed.
   Time them. Over twelve minutes → cut a scenario. Do not talk faster.

4. Write DEMO_SCRIPT.md: exact click path, the seed, what to say at each beat.

5. Load test: 200 concurrent jobs, 40 units. Record solver p95, WebSocket
   fan-out latency, and WHERE IT BREAKS. Knowing where it breaks is the
   answer to "how does this scale."
````

**Check:** the full demo runs clean twice in a row from a reset database.

**Close:** `log this phase in DECISIONS.log` → `git commit -m "phase 25: verify and rehearse"`

---

# PHASE 26 — Ship

````
Deploy and document.

1. DEPLOY — topology is locked:
   ONE platform. ONE origin. TWO always-on processes.
     web    → Express + Socket.IO + static /public
     worker → BullMQ processors + simulator, autonomous mode ON
     managed Postgres + managed Redis

   - NO free tier that sleeps. The simulator, queues and WebSocket
     connections must stay up. A spun-down Zippy is an empty board, which
     proves less than a screenshot.
   - NO separate frontend host. Vercel and similar do not fix a cold start
     (that lives in the API and WebSocket, not the HTML) and cannot hold
     persistent WebSocket connections.
   - migrations run on release (prisma migrate deploy), never by hand
   - seed is idempotent; scheduled reset every 4 hours, announced in the UI
   - four demo accounts, dispatcher featured
   - LLM: per-IP rate limit + global daily token budget that trips the
     Phase 17 DEGRADED mode when exceeded. The resilience fallback is also
     the cost ceiling.
   - chaos controls dispatcher-gated, rate-limited, auto-recovering
   - health checks wired to the platform's uptime monitor

2. README. Fill EVERY benchmark cell from a real `npm run eval` run.
   DO NOT invent a number. If global loses somewhere, publish the loss. An
   interviewer who runs the harness and gets different numbers than your
   table will stop believing everything else you said.

3. Architecture diagram matching src/ exactly.

4. EVALUATION.md: full sweep results including losing scenarios and the
   coverage ablation finding.

5. CHAOS_TESTING.md: every degraded state and what it does.

6. A "Deliberately not built" section: multi-stop routing, cross-van part
   transfer, coverage as a forecast optimiser — and why each line was held.

FINAL CHECK: clone the repo into a fresh directory, follow your own README
changing nothing, run the eval. If the numbers do not match, the number does
not go in the README.
````

**Check:** a stranger can clone, run, and reproduce your headline table. Open the live URL in an incognito window and time how long until something interesting happens with zero clicks. Over 30 seconds → turn the simulator rate up.

**Close:** `log this phase in DECISIONS.log`, then `consolidate DECISIONS.log into INTERVIEW.md` → `git commit -m "phase 26: ship"`

---
---

# IF YOU FALL BEHIND

Cut in this order. Each is defensible if you can say *why*:

1. **Phases 23–24** (coverage) — specified headroom
2. **Phase 21** (fleet dashboard) — keep Phase 20's tenancy in the engine, cut the UI
3. **Phase 22's learned P(accept)** — keep the acceptance offer, use a flat prior
4. **Phase 14 item 5** (the live map) — the timeline and why-panel matter more

**Never cut:** Phase 10 (evaluation), 11 (concurrency), 12 (saga), 13 (re-dispatch), 17 (degradation). Those five are the project.

# RED FLAGS

Any of these means go back, not forward:

- Tests exist but you never watched one fail
- `npm run test:concurrency` finishes in under a second
- Every scenario is won by global
- Prisma imports found in `/src/engine`
- The rejected-alternatives list is empty in the why-panel
- A chaos toggle leaves the system stuck
- The dispatch table flickers or loses scroll during the simulator run
- Two runs with the same seed differ
- A SCREAMING_CASE enum appears in the driver UI
