# DEMO_SCRIPT.md

The live walk-through. One clean seed, target **under twelve minutes**.

**The twelve-minute run is beats 1, 2, 4, 5, 6, 7, 8, 9** — the per-beat
estimates below sum to ~10.5 min plus ~1 min of open/close. **Beats 3 and 10
(`[CUT FIRST]`) are backup**, not part of the timed run: keeping all ten puts
the paper budget at ~13.5 min, over the limit before a word is spoken. Pull 3
back in if the room wants the honest-loss story; pull 10 in if they push on
tenancy. Do not talk faster to fit them.

> **Status: click paths spot-checked against a live build, not yet timed.**
> From a fresh `db:reset`: beats 1, 2, 4 walked end to end in the browser;
> beat 5 confirmed over HTTP (a `STUCK_OR_DAMAGED` job returns a `CHOSEN`
> destination with a three-workshop `screened` shortlist); beat 6's simulator
> confirmed to generate and write board load; beat 9's endpoint returns the
> right shape. Beats 3, 7, 8, 10 are from the code and a chaos-panel DOM read
> only. Phase 25's check — "runs clean twice from a reset database, under
> twelve minutes" — still needs a human with a real Chrome window and a
> stopwatch; automated runs from this repo hit browser-harness screenshot
> timeouts and cannot be trusted for timing.
>
> **Beat 9 needs setup on a fresh seed** — see the note in that beat.

---

## Before the room is watching

```bash
docker compose up -d                 # postgres, redis, osrm
npm run db:reset && npm run db:seed  # 6 zones, 24 units, 31 technicians, 12 workshops, 3 depots
npm run dev                          # web process  — http://localhost:3000
npm run dev:worker                   # worker process — leave both running
```

Seed is fixed; a reset gives byte-identical fixtures every time. If OSRM is not
up, candidate generation falls back to haversine and every travel time on
screen is flagged degraded — fine for a dry run, wrong for the real thing.

**Logins** — every seeded user shares the password `password-dev-only`.

| role | email | page |
| --- | --- | --- |
| dispatcher | `dispatch-ops@zippy.internal` | `/dispatcher.html` |
| fleet manager | `fm-metrocab@zippy.internal` | `/fleet.html` |
| technician | `tech1@zippy.internal` (…`tech31`) | `/technician.html` |
| driver | `driver-metrocab-1@zippy.internal` (…`driver-<tenant>-<n>`) | `/driver.html` |

Each login page pre-fills its own email and the dev password, so signing in is
one click on **Sign in**. Open four tabs: dispatcher, driver, technician,
fleet. Dispatcher is the tab you present from; the others you cut to.

> Beats 1, 2 and 4 and the panel/label names below were walked against a live
> run from a fresh seed. Beats 3, 5, 6, 9, 10 have not been walked end to end —
> confirm them on the first rehearsal.

**One line to open with:** "Zippy dispatches roadside breakdowns for
time-to-*resolution*, not time-to-arrival. The nearest van is often the wrong
van, because it cannot fix the fault and a second dispatch has to happen. Every
number I show you comes out of `npm run eval` against the same engine the
server runs."

---

## Beat 1 — normal-day: the inversion, on one job  ·  ~90s

**Objective:** show arrival and resolution disagreeing on a single dispatch.

1. Driver tab → the free-text box on "Tell us what happened" → type *"car
   won't start, no lights at all, engine doesn't turn over"* → **Continue**.
2. Symptom picker ("What has happened…") — the extractor pre-lights *"It will
   not start"*, leave it; **"Which vehicle?"** is pre-filled, leave it. (With
   no LLM key configured you'll see *"Our assistant is unavailable right now,
   so we will ask you a few questions instead"* — the keyword fallback still
   lights the complaint; it's a fair aside about the DEGRADED intake path.)
   → the entropy question ("What do you hear…"), answer or skip → safety
   checkboxes, leave the high-risk ones **unchecked** → location: pick a road
   position (e.g. *"On a service road or side street"*) → **Send for help**.
3. Dispatcher tab → **Solve — plan every pending job** → then click the job's
   id in the **LIVE INCIDENT TIMELINE** (or the priority queue) to load the
   inspector.
4. **WHY THIS TECHNICIAN?** panel → read the header (`believed:` the fault
   distribution, `requires:` the capability set, "covers N% of the fault
   distribution") and the cost-breakdown table term by term (`slaRisk`,
   `travelDistance`, `operationalCost`, `partSourcingCost`,
   `contractSlaExposure`, `destinationRefusalRisk`). Scroll past **Chosen** to
   the rejected options and point at a nearer, narrower van with its reason
   code.

**Say:** "The van it turned down is closer. It went with the broader crew
because that crew covers 86% of the fault distribution — expected time to
*resolution* is lower even though arrival is worse. That trade is the product."

**Expect:** chosen crew is broad-capability; a closer capability-rejected
option is listed with its code.

---

## Beat 2 — capability-scarcity: four plans, priced  ·  ~60s

**Objective:** the solver offering ranked whole-board plans, not one answer.

1. Dispatcher → the plan cards under the **Solve** button: **FASTEST_RESOLUTION**,
   **LOWEST_COST**, **BALANCED** (marked `RECOMMENDED`), **PROTECT_CONTRACTS** —
   each with a `TOTAL` and its per-job unit + cost.
2. Point at the `TOTAL` delta between BALANCED and FASTEST_RESOLUTION, and at
   the **CAPABILITY SCARCITY** panel — `EV_HV_CERTIFICATION` shows `CRITICAL`,
   several others `THIN`.
3. Selecting BALANCED is one click ("Select this plan"); the other three are
   `OVERRIDE` and need a typed reason first. Select BALANCED → the card flips
   to **selected**, a `PLAN_SELECTED` event lands in the timeline.

**Say:** "The planner assigns the whole pending board at once, so a job whose
only possible crew would have gone to a marginally better match elsewhere is
not stranded. Four cards ranked by the cost function — BALANCED is the default;
PROTECT_CONTRACTS is the same board with the contract-exposure weight turned up
ten times. No hidden tiebreak."

---

## Beat 3 — ambiguous-diagnosis: where the approach *loses*  ·  ~75s  `[CUT FIRST]`

**Objective:** honesty. Show the scenario the harness scores against us.

1. Driver tab → free-text box → something deliberately vague: *"weird noise and
   a warning light, not sure what."* → step through and **Send for help**.
2. Dispatcher → **Solve** → open the inspector for that job → show the
   `believed:` distribution is spread across several faults and the `requires:`
   capability set is wide.
3. Cut to terminal: `npm run eval -- --scenario ambiguous-diagnosis` (or point
   at `EVALUATION.md`).

**Say:** "On ambiguous-diagnosis the global policy resolves 19 of 60 against
nearest-unit's 22. Its mean is faster and its first-visit rate is higher, but
it strands more chasing a crew who can cover every branch, and the harness
scores that scenario on jobs served. It prints the loss. `eval:sweep` shows
the same weak point under load — it is the scenario with the least diagnostic
signal to act on."

---

## Beat 4 — parts-stockout + the driver's part-sourcing message  ·  ~90s

**Objective:** the inventory layer, and the sentence the driver sees.

1. A won't-start job often already triggers this (the seed's battery faults
   pull `BAT-45AH` / `STR-MOTOR-RECON`); otherwise create one with *alternator*
   / *warning light* symptoms. Dispatcher → inspector → under the chosen crew,
   a line like *"collecting BAT-45AH, STR-MOTOR-RECON on the way — 2.9 min
   detour"*, and a non-zero **`partSourcingCost`** row in the cost table.
2. Cut to the **driver tab** for that job. The status line reads:
   > "<crew name> has the skills for this but needs a part. We are arranging it
   > now."

**Say:** "The driver is never told 'stock-out'. The system knows this crew is
qualified and empty-handed, routes them via a depot, and prices the detour into
the same objective. A policy with no inventory model cannot even see this
happening — that is the `stockout fails` column, 50 to 149 for the baselines
and near zero here."

---

## Beat 5 — destination screening: where a tow goes  ·  ~90s

**Objective:** the workshop-network decision and its audit panel.

1. Create a tow-only job: describe *"had an accident, car can't be driven,
   stuck in the live lane"* → high-risk safety, highway situation → create.
2. Dispatcher → inspector → **destination screening panel**: the shortlist of
   workshops, each row showing brand authorisation, EV-class fit, open-now,
   real road distance **job → workshop**, and the learned P(accept). The chosen
   one is marked.
3. Cut to the driver tab: "Confirming a workshop that can take your car." →
   later "Your car is on its way to the workshop."

**Say:** "For a tow the destination is resolved once per job — brand, EV class,
opening hours in IST, real road distance in the direction the tow actually
drives, and a Beta-Bernoulli estimate of whether the workshop will say yes.
The refusal risk is a cost term in minutes, and the saga's third leg finally
has a real caller."

---

## Beat 6 — monsoon-surge: the board under load  ·  ~75s

**Objective:** the console holding up while jobs pour in.

1. Terminal: `npm run sim -- --live --rate 45 --duration 60` — `--duration` is
   in *simulated* minutes and live mode runs ~1 real second per simulated
   minute, so this is about a one-minute burst; add `--pace 2` to slow it.
2. Dispatcher → the **PRIORITY QUEUE** and bottom job strip fill; the header
   count ("Jobs on the board: N") climbs. Scroll halfway, select a job, **wait**.
3. Scroll position and selection hold; no flicker (rows patch by
   `data-job-id`, nothing rebuilds). `Solve` now reports hundreds of options
   and `zonePartitioned: true`.
4. Stop the surge: `docker compose exec redis redis-cli SET zippy:sim:stop 1`.

**Say:** "Forty-five jobs an hour. The table patches row by row over a
WebSocket — scroll and selection survive, which is the difference between a
console and a toy. Under this load the global policy resolves roughly twice
what the greedy policies do."

---

## Beat 7 — technician-dropout via the chaos panel  ·  ~75s

**Objective:** a mid-incident resource failure, visibly handled.

1. Dispatcher → **chaos panel** ("break-it panel", dev builds only) →
   **Take a technician offline** on a crew that is currently on a job.
2. Watch the job re-enter the pending list; the re-dispatch fires; a new plan
   is proposed.
3. Point at the **timeline** for that job — the dropout and the reassignment
   are both events, not a silent swap.

**Say:** "The panel does not exist in a production build — the routes are not
registered, so a leaked token can't reach them. Here it lets me pull a crew
off the road mid-job. The job re-queues, re-dispatches, and every step writes
a JobEvent. Nothing degrades quietly."

---

## Beat 8 — chaos CRITICAL banner  ·  ~60s

**Objective:** invariant 8 — every degraded state is visible.

1. Dispatcher → chaos panel → turn on **Redis (queues and fan-out)** and
   **Live updates**.
2. The **health banner** appears at the top: amber for one component down, red
   (`CRITICAL`) when the combination crosses the line — a sentence the server
   wrote, listing only the broken components.
3. Turn both switches off → the banner clears itself within one health-loop
   tick (~15s), or instantly because the toggle re-runs the probes.

**Say:** "Green is never shown — a permanent status bar stops being read. This
bar only appears when something is wrong, the wording comes from the server so
there's one source of truth, and it recovers on its own. `CHAOS_TESTING.md` is
written from a real walk-through of all six components."

---

## Beat 9 — repeat-pattern flag on the fleet dashboard  ·  ~60s

**Objective:** the tenancy / fleet-manager surface.

> **SETUP — do this before the demo, off screen.** On a fresh seed the
> dashboard is empty of history: `slaMetPercent` and every `repeatPatternFlag`
> come back `null`, so there is nothing to point at. To have a flag to show,
> create and **resolve** two `FLAT_BATTERY` jobs on one metrocab vehicle
> (`vehicle-metrocab-1`) inside the pattern window first — through intake, or a
> small script — so the second one trips the rule. Confirm with
> `GET /fleet/dashboard` as `fm-metrocab@zippy.internal` that a vehicle now has
> `repeatPatternFlag` non-null before you go live.

1. Fleet tab (logged in as `fm-metrocab@zippy.internal`) → **fleet
   dashboard**: this manager's own SLA %, a boolean current-exposure figure,
   spend, and incident history — scoped to their tenant only.
2. Point at the vehicle carrying the **repeat-incident flag** — a rule, not a
   model: the same exact fault code seen more than once inside the window.

**Say:** "A fleet manager sees only their own vehicles — the Prisma extension
rewrites every query by tenant, and cross-tenant reads are audited. The
repeat flag is rule-based and matches on the exact fault code; it deliberately
does not merge `FLAT_BATTERY` and `FAILED_BATTERY`, and I can tell you why
that's a known limitation."

---

## Beat 10 — cross-tenant contention → APPROVE card  ·  ~75s  `[CUT FIRST]`

**Objective:** a contract decision that needs a human.

1. Set up two pending jobs from different tenants whose only viable crew is the
   same unit (easiest: a scarce-capability job from a GOLD-contract fleet and a
   consumer job at the same safety level).
2. Dispatcher → the losing job raises an **APPROVE-tier** ActionRequest — the
   contested unit named, both costs on the card.
3. Approve it → exactly one card resolves; a duplicate solve does not raise a
   second (guard is read-then-write, a known non-atomic gap).

**Say:** "Safety is a lexicographic ordering above the cost function — a
contract tier cannot buy its way past a HIGH_RISK consumer. When two tenants
genuinely contend for the last crew, the system does not silently pick a
winner; it escalates to an APPROVE card with both numbers on it."

---

## Close  ·  ~30s

"Phases 0 through 22 — the build plan's ship point. 800 fast tests, a
concurrency suite against a real Postgres, `npm run eval` byte-identical across
runs. The coverage engine in Phases 23–24 is scoped and deliberately not built:
I wasn't going to ship a recommendation system I couldn't defend line by line.
Everything you saw is one origin, two always-on processes, no external API in
any dispatch decision."

---

## Reset between full run-throughs

```bash
docker compose exec redis redis-cli DEL zippy:sim:stop
# on the dispatcher: chaos panel → Reset everything
npm run db:reset && npm run db:seed
```
