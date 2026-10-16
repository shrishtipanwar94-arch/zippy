# DEMO.md — one breakdown, three windows, start to dispatched

The minimal live demo: a flat battery reported by a driver, planned by the
dispatcher, offered to a technician, accepted. One zone, one driver, and **four
crews, each wrong in a different way but one**, so the solver has a real choice
to make and the dispatcher's screen can show why it made it.

This is the short demo. `WALKTHROUGH.md` is the long one against the full
24-unit board, and `DEMO_SCRIPT.md` is the presentation script with nine beats.
This file is the one you run when you want to see a dispatch work.

**Steps 1-5 were walked over the real HTTP API on the original one-crew board**
before they were written down. The four-crew facts below — who is rejected,
who wins, what each plan picks — were measured with
`scripts/demo-dry-check.ts` and the real solver against the new board. The
browser screens for the four-crew board have NOT been re-walked end to end yet;
where a screen's content depends on the crews, it is marked *(measured via the
engine, not yet seen in a browser)*.

---

## The four crews

All four start the day in the demo zone, on shift, stocked
(`src/demo/demoCrews.ts`). The driver is at Connaught Place — the driver form's
default coordinates. The job needs `JUMP_START` and `BATTERY_REPLACEMENT`, and
no tow.

| crew | technician | unit | where | can do | carries | verdict for a flat battery |
| --- | --- | --- | --- | --- | --- | --- |
| A | Imran Sheikh | DMO-VA, van | Janpath, ~0.6 km | `JUMP_START` | nothing | rejected **`CAPABILITY_MISSING`** — nearest, but cannot replace a battery |
| B | Ravi Kumar | DMO-VB, van | Gole Market, ~1.9 km | `JUMP_START`, `BATTERY_REPLACEMENT` | `BAT-45AH` | **chosen** |
| C | Gurpreet Singh | DMO-VC, flatbed | Barakhamba Rd, ~1.5 km | both, plus `FLATBED_LOADING` | nothing | rejected **`PART_UNAVAILABLE`** — has the skill, no battery, no depot to fetch one |
| D | Meera Nair | DMO-VD, van | Hauz Khas, ~7.4 km | both, plus `ALTERNATOR_REPLACEMENT`, `OBD_DIAGNOSTICS` | battery, alternator, belt, starter | feasible, **costs more** |

The interesting one is D. It covers 96% of the fault probability against B's
80% — it could also fix an alternator — and the cost function genuinely values
that, because a crew that can fix more saves a second callout. At ~4.4 km D
actually WON, and the seed was moved, not the engine (see the comment on crew D
in `src/demo/demoCrews.ts`). At 7.4 km the travel outweighs the coverage.

What `scripts/demo-dry-check.ts` printed in production's routing mode
(`ROUTING_MODE=HAVERSINE`), lines joined for width — the script prints each
verdict on the line under its crew:

```
  B  DMO-VB Ravi Kumar      FEASIBLE            5.3 min haversine, BALANCED cost 41.91
  D  DMO-VD Meera Nair      FEASIBLE           20.6 min haversine, BALANCED cost 55.69
  A  DMO-VA Imran Sheikh    CAPABILITY_MISSING  1.6 min haversine — missing: BATTERY_REPLACEMENT
  C  DMO-VC Gurpreet Singh  PART_UNAVAILABLE    4.2 min haversine — no source for BAT-45AH
THE SOLVER CHOOSES (BALANCED plan): B  DMO-VB Ravi Kumar
PASS — crew B wins, as the demo board was built to show.
```

With local OSRM road times instead: B 6.5 min / 43.18, D 13.0 min / 47.86, and
B still wins.

**It exits non-zero unless B is chosen**, so a board that would make the wrong
choice fails there rather than in front of an audience. If it fails, fix the
seed, not the engine.

---

## 0 — Before you open a browser

### On the deployed site

Nothing to run. With `DEMO_MODE=true` the web service builds this board on
every boot and the worker keeps the crews on shift and stocked every fifteen
minutes (docs/DEPLOYMENT.md). The password for every account is the
deployment's `SEED_PASSWORD`, **not** `password-dev-only`.

To check the deployed board before presenting, from a machine logged in to the
Railway project: `railway ssh -s web -- npx tsx scripts/demo-dry-check.ts`.

### Locally

```bash
docker compose up -d postgres redis osrm   # osrm is optional — see below
bash scripts/demo-reset.sh                 # DROPS THE DATABASE, then seeds the demo board
npm run dev                                # window 1 — http://localhost:3000
npm run dev:worker                         # window 2 — the offer-expiry timer lives here
```

`demo-reset.sh` finishes by running the dry check above. After a clean reset
the census line reads one zone, four technicians, four shifts, four units and
no jobs waiting.

**The worker must be running.** A technician offer expires in 45 seconds
(`OFFER_TTL_MS`) and the expiry job lives in the worker process. Without it an
offer never times out, which hides a real behaviour rather than breaking the
demo — but the health loop is in there too, so the dispatcher's banner will be
wrong.

### Road routes or straight lines

Travel time comes from OSRM locally and from haversine in production
(`ROUTING_MODE`, reported by `GET /health` as `routing.mode`). A haversine
estimate is a straight line × 1.4 road factor at 30 km/h and is flagged
`degraded` everywhere it appears, because it is not a road route. Locally,
`docker compose up -d osrm` (~17 s to answer) gives real road times; run
`scripts/setup-osrm.sh` once first if the extract was never built.

**The routing mode changes one plan card.** Measured against this board:

| routing | FASTEST_RESOLUTION | LOWEST_COST | BALANCED | PROTECT_CONTRACTS |
| --- | --- | --- | --- | --- |
| haversine (production) | B | B | B | B |
| OSRM (local) | **D** | B | B | B |

On real roads D is close enough that the plan weighted hardest on resolution
time prefers its wider coverage. That is a good thing to point at locally — the
plans disagree, and each for a stated reason. In production all four agree.

### What the health banner will show

**A fresh board shows no banner at all.** The banner is invisible when
everything is NORMAL, by design. All seven components come up NORMAL:
`CREW_ON_SHIFT` reads "4 of 4 crewed units have a technician on shift".

**Routing being haversine does not appear on the banner.** There is no routing
component on the ladder — the seven are `AI_EXTRACTION`, `GPS`, `WEBSOCKET`,
`SOLVER`, `PAYMENTS`, `CREW_ON_SHIFT` and `DISPATCH_CORE`. It is stated in
`GET /health` instead.

**Two components will turn the banner amber if you leave the board sitting**,
both only after the technician has accepted:

| component | fires after | why, on this board |
| --- | --- | --- |
| `PAYMENTS` | **10 min** (`PAYMENT_PENDING_AFTER_MS`) | accepting creates a callout authorisation; with no reachable payment provider it stays `PENDING_AUTHORISATION`, and dispatch is never blocked on it |
| `GPS` | **15 min** (`POSITION_STALE_AFTER_MS`) | the probe only looks at units on an active job, and nothing in this demo reports a new position after the seed stamps one |

`CREW_ON_SHIFT` will not degrade: locally the shift runs eight hours from the
seed, and on the deployed site the worker re-opens it every fifteen minutes.

### The three windows

| window | URL | email | what it is |
| --- | --- | --- | --- |
| Driver | `/driver` | `demo-driver@zippy.internal` | Asha Rao, whose Swift will not start |
| Dispatcher | `/dispatcher` | `demo-dispatcher@zippy.internal` | the board |
| Technician | `/technician` | `demo-tech-b@zippy.internal` | Ravi Kumar, crew B, in van DMO-VB — the crew that wins |

Paths are on `http://localhost:3000` locally or on the deployed URL. Password:
`password-dev-only` locally, the deployment's `SEED_PASSWORD` on the deployed
site. **Each page pre-fills the MAIN seed's account, not the demo one**
(`driver-metrocab-1@`, `dispatch-ops@`, `tech01@`), so replace the email with
the one above before signing in. The other three crews sign in as
`demo-tech-a@`, `demo-tech-c@` and `demo-tech-d@`; nothing is offered to them
in this script.

**Sign in to all three before you start**, and leave the technician window
visible. The offer it has to answer lasts 45 seconds.

**Expect** on the dispatcher: the connection dot beside the wordmark goes green,
the board is empty, and **no red banner** — a banner only appears when something
is wrong, so its absence is the healthy state.

---

## 1 — The driver reports a flat battery

All of this is the **structured symptom picker**. No Anthropic key, no LLM, no
`/describe` free-text box — the picker is the path that needs nothing
configured.

In the **driver window**, a four-step stepper:

1. **"What has happened?"** opens on a FREE-TEXT box — that is the LLM path.
   Press **"Skip — I'll answer questions"** to take the picker instead.
2. **"What's wrong with the vehicle?"** → **It will not start**. The vehicle
   dropdown below already reads **DL01DM0001** (White Maruti Suzuki Swift); it
   is the only one.
3. **"Are you safe where you are?"** → **"I am on my own" is already ticked**.
   Leave it and press **Continue**. (That tick is why the job comes out
   `ELEVATED` rather than `NORMAL`.)
4. **"Where are you?"** → choose **In a car park or driveway**, type a landmark,
   and press **Send for help**.

   **DO NOT PRESS "Use my current location"** unless you are in Delhi. It
   captures your real GPS, and intake correctly refuses anything outside the
   service area — *"We do not cover where you are yet. The nearest place we work
   is Delhi, about N km away."* Worse, the captured fix lives in the
   page's own state, so editing the coordinate boxes afterwards does not
   override it; only a reload clears it, and a reload signs you out. The
   coordinate boxes already default to the demo zone, so leave them alone.

Then it asks follow-up questions — intake's entropy-driven questioning, not a
fixed form, so it stops as soon as more answers cannot change who gets sent.
With a coherent battery story it asks **three**:

| it asks | answer |
| --- | --- |
| "What do you hear when you try to start it?" | **A rapid clicking** |
| "Before it stopped, was the battery or charging light on while you were driving?" | **No** |
| "Do the dashboard lights come on, and are they bright or dim?" | **They are dim, or nothing comes on** |

Those three are the battery-consistent answers and they matter. A rapid click
with dim lights is the classic flat-battery signature; answering **Yes** to the
charging light points at a failing alternator instead, and answering the
key-detection question with *"key not detected"* points at a key fault — and
no demo crew holds `KEY_PROGRAMMING`, and only D holds
`ALTERNATOR_REPLACEMENT`. Answer it as a different fault and the board makes a
different, correct choice — not the one this script describes.

**Expect, on the driver's own screen:**

- The headline reads **"We are taking down the details of your breakdown."**
  while questions remain — this is correct, and it is *not* the same sentence as
  the one after intake finishes.
- Once the picker runs out of questions the headline becomes **"Finding someone
  equipped for this."**
- **Progress** shows the job's stage.

**Expect, on the dispatcher:** the job appears in the **priority queue** with
the plate `DL01DM0001`, a safety badge reading **NORMAL**, and its three sort
keys (safety, SLA consumption, age) on the row. It is `NORMAL` because the car
is in a car park with nothing dangerous reported — safety triage returns no
reason codes at all, which is what makes the escalation in Step 3 visible as a
change rather than as noise.

> **What the classifier actually concluded**, from the dry check: 50.1%
> `FLAT_BATTERY`, 30.3% `FAILED_BATTERY`, 11.9% `ALTERNATOR_FAILURE`. Intake
> stops asking when the remaining contenders all need the same skills, so the
> job's requirement is `BATTERY_REPLACEMENT, JUMP_START` — both of them, because
> a 50/30 split should send somebody who can do either.

---

## 2 — The dispatcher plans it

**Dispatcher window.** Press **Solve — plan every pending job**.

**Expect:** the **solve trace** fills in one line at a time rather than pausing
and dumping a report — how many jobs were waiting, how many crew-and-job
combinations existed, how many survived the hard filters, that the dangerous
jobs were matched in a round of their own, and how long the whole thing took.
The last stage line carries the wall clock; on a four-van board there is very
little to do, so read it off the screen rather than expecting a figure. The
trace should count **4 options, 2 surviving the hard filters**.

Then **four plan cards** appear: `FASTEST_RESOLUTION`, `LOWEST_COST`,
`BALANCED`, `PROTECT_CONTRACTS`. On the deployed site (haversine) all four
choose **B, Ravi**. Locally with OSRM, `FASTEST_RESOLUTION` chooses **D,
Meera** and the other three choose B — see "Road routes or straight lines"
above for why. *(Measured via the engine, not yet seen in a browser.)*

Press **"Why this technician?"** on the job to open the **inspector**.

**Expect** *(measured via the engine, not yet seen in a browser)*: the cost
breakdown term by term for B, then the alternatives:

- **D, Meera** — feasible, higher cost. Its coverage term is better than B's
  (it could fix an alternator too) and its travel and operational terms are
  worse. This is the line to talk over: the solver weighed a real trade-off.
- **A, Imran** — `CAPABILITY_MISSING: missing: BATTERY_REPLACEMENT`. The
  nearest crew, and the one "send the closest van" would have sent.
- **C, Gurpreet** — `PART_UNAVAILABLE: no source for BAT-45AH`. Has the skill,
  not the battery, and there is no depot on the demo board to fetch one.

Hard constraints are filters with reason codes, never penalties (invariant 3),
which is why A and C appear as rejections with a sentence rather than as
expensive options.

Now press **Record this decision** on the `BALANCED` card.

**Expect:** the button becomes **decision recorded**.

> **THIS HAS NOT DISPATCHED ANYBODY, AND THAT IS THE DESIGN.** The response says
> `decisionsRecorded: 1` and the technician window is still empty. Recording a
> plan writes down which plan a human chose; turning one assignment into a real
> three-leg reservation is a separate, human-taken step. Say this out loud —
> somebody watching will assume the job is now on its way, and the next step is
> the one that puts it there.

---

## 3 — The driver's situation changes, which is what triggers the offer

The reservation starts from a `REASSIGN_*` card in the action queue, and that
card is raised by a **re-plan trigger**. There is no dispatcher-side "dispatch
now" button; the honest way to produce a trigger entirely from the UI is for the
driver's situation to change.

**Driver window.** Scroll to **Messages** and send:

> `I am blocking moving traffic and it is not safe`

**Use that sentence, not the one in WALKTHROUGH.md.** Messages are classified by
`classifyMessageWithAi`, which falls back to the phrase list in
`src/domain/messageClassifier.ts` when no model is configured. WALKTHROUGH's
*"I have had to move into the traffic lane…"* is caught by the MODEL and matches
**no phrase** — `"into the traffic lane"` does not contain `"in the lane"` — so
with `LLM_API_KEY` unset it raises nothing at all and the demo dead-ends. The
sentence above hits `blocking` and `not safe`, so it works either way.

**Expect, within a second, on the driver's own screen:** a bordered amber card
asking **"Are you blocking moving traffic?"** with a line underneath — *"This
changes how we prioritise your job — we will send whoever can reach you
fastest."* — and **Yes** / **No**.

It is on the driver's screen and not the dispatcher's on purpose: the driver is
the only person who can see the traffic. A message never changes the job by
itself; a human confirms it.

Press **Yes**.

**Expect:**

- **Driver:** an update line saying the job has been moved up the queue.
- **Dispatcher:** the queue row gains a red **HIGH RISK** badge and jumps to the
  top; `SAFETY_LEVEL_CHANGED` lands in the timeline.
- **Dispatcher:** one new card in the **ACTION QUEUE** —
  `Recommended · REASSIGN_AFTER_TRIGGER`, reason **"confirmed from a message:
  safety change"**, naming the crew it would move the job **to** — **B, Ravi**.
  A HIGH_RISK job is solved in its own safety band first, and the recommended
  plan still chooses B at HIGH_RISK (measured, both routing modes).

---

## 4 — The dispatcher reserves the crew

**Dispatcher window.** On that `REASSIGN_AFTER_TRIGGER` card, press **Execute**.

**Expect:** the response reserves a crew — `reserved: true`, saga
`SAGA_STARTED`. The van is now **held**, not assigned: a hold with a TTL, taken
with a conditional update on the version the plan was computed against, so a
second dispatcher pressing the same button loses the race rather than
double-booking the van.

**Expect on the driver:** the headline becomes **"We have asked a technician to
come. Waiting for them to confirm."**

**Now look at the technician window.** You have 45 seconds.

---

## 5 — The technician accepts

**Technician window.** Under **New job offers** there is one card: the job, its
safety level, and a countdown.

**Expect:** **Accept** and **Decline** buttons.

Press **Accept**.

**Expect:**

- **Technician:** the offer disappears from **New job offers** and the job moves
  into the technician's own job list with status `COMMITTED`.
- **Driver:** the headline becomes **"Ravi is on the way."** — the technician's
  first name, because that is who is actually coming.
- **Dispatcher:** the job leaves the priority queue; the timeline records the
  commit.

The saga is now `COMMITTED`: the hold was consumed, the offer answered, and the
job carries the unit and the technician. That is a full dispatch.

---

## What each screen shows, in one table

| after step | driver headline | dispatcher | technician |
| --- | --- | --- | --- |
| 1 (reporting) | "We are taking down the details of your breakdown." | — | empty |
| 1 (picker done) | "Finding someone equipped for this." | job in the priority queue | empty |
| 2 (plan recorded) | unchanged | four plan cards (B on all four in production), inspector shows D feasible but dearer, A and C rejected with codes; **decision recorded** | **still empty** |
| 3 (driver confirms Yes) | moved up the queue | HIGH RISK badge + `REASSIGN_AFTER_TRIGGER` card | empty |
| 4 (Execute) | "We have asked a technician to come. Waiting for them to confirm." | card resolved, van held | **offer, 45s** |
| 5 (Accept) | "Ravi is on the way." | job leaves the queue | job `COMMITTED` |

---

## If something does not happen

**No job on the dispatcher's queue.** The driver has not finished the picker.
The headline is the tell: "taking down the details" means questions remain.

**`Recommended · No crew can take this job` instead of the reassignment card.**
A re-solve found nothing. The card's reason line carries the breakdown by reason
code — read it. Re-run `npx tsx scripts/demo-dry-check.ts`: it prints the same
verdict without needing a browser.

**Nothing is feasible and the reason is `NO_TECHNICIAN_ON_SHIFT`.** The shift
window has passed. On the deployed site the worker re-opens it every fifteen
minutes, so this means the worker is down — check it. Locally, run
`npm run db:seed:demo` again: it moves the window forward and leaves any van on
a live job alone.

**The card names D, not B.** Crew B is busy — it is already on a job, or an
offer for it is counting down — so the next-best feasible crew is chosen. That
is correct behaviour, not a broken board. The dry check reports it as
`UNIT_UNAVAILABLE` for B and FAIL.

**The offer expired before you pressed Accept.** 45 seconds is the real TTL.
Start again from Step 3: send another message and confirm it. The van goes back
on the board when the offer times out. See the note below before you consider
making it longer.

### Giving yourself longer than 45 seconds

Both clocks are environment variables, and 45 seconds is only the default:

| variable | default | what it governs |
| --- | --- | --- |
| `OFFER_TTL_MS` | `45000` | how long the technician's phone counts down |
| `HOLD_TTL_MS` | `120000` | how long the van stays held while that happens |

**For a demo where you are talking through the screen**, put this in `.env`
before starting the two processes — three minutes to answer, five minutes of
hold:

```
OFFER_TTL_MS=180000
HOLD_TTL_MS=300000
```

**They are coupled, and the process refuses to start on a bad pair.** The hold
must outlive the offer by at least 15 seconds (`ACCEPT_ROUND_TRIP_MARGIN_MS`),
because an offer that outlives its hold is the worst shape these two can take:
`consumeHold` updates `WHERE status = 'ACTIVE' AND expires_at > now` and
`releaseExpiredHolds` in `src/workers/cleanup.ts` marks anything past its expiry
`EXPIRED_BY_SWEEP`, so a technician pressing **Accept** would see a live
countdown and the reservation would fail with **nothing to retry**.

Raise the offer alone and you get this instead of a broken demo:

```
Invalid environment configuration. The process cannot start:
  - HOLD_TTL_MS: OFFER_TTL_MS is 300000ms and HOLD_TTL_MS is 120000ms, but the
    hold must be at least 315000ms (the offer plus a 15000ms margin for the
    accept to land). ... Raise HOLD_TTL_MS or lower OFFER_TTL_MS.
```

The shipped defaults are deliberate — 45 seconds is right for a technician who
is working, and two minutes stops a van being stranded by a dispatcher who
closed their laptop — so they are unchanged. `tests/configTtlPair.test.ts`
covers the rule, the wiring, and that the defaults satisfy their own
constraint.

**The dispatcher's banner is red.** Read it — it names the component and what
the fallback is. `Crew on shift` degraded means the shift has lapsed; see above.

---

## Running it twice

**After the first run, crew B is busy.** Invariant 7 is one active job per
unit, so once the demo job is `COMMITTED` van DMO-VB is `ON_JOB` and the next
flat battery goes to **D, Meera** — the only other feasible crew (measured: B
`UNIT_UNAVAILABLE`, solver chooses D).

**To get B back:**

- **On the deployed site**, finish or cancel the first job (the technician
  window walks it through to resolved). Once B has no live job, the next
  fifteen-minute refresh — or the next boot — puts it back home, on shift and
  stocked. Neither ever touches a van with a live job.
- **Locally**, `bash scripts/demo-reset.sh` drops the database and starts clean.

**`npm run db:seed:demo` no longer refuses while a van is busy.** The first
version of this seeder refused to run at all while its one van had a live job,
because forcing that van back to `AVAILABLE` would let a second job onto it —
invariant 7 broken by the fixture rather than the product, observed once as
two holds 46 seconds apart, both consumed, with a re-seed between them. Now
that the same code runs on every web boot, a refusal would stop the site
starting, so a busy van is **skipped** instead and named in the output:

```
  left alone, on a live job: DMO-VB
```

`tests/demoBoard.test.ts` pins both halves: the seed is idempotent, and the
refresh leaves a van with a live job exactly as it was.

**Getting the big board back:** `npm run db:reset` rebuilds the full 24-unit
seed. The demo board never modifies it — `prisma/seed.ts` and
`prisma/seed/demoMinimal.ts` are independent entry points, and the evaluation
harness and test suites still read the main one.

---

## Checked against the deployed site

Walked read-only on 2026-10-17 against the Railway deployment, BEFORE the
cutover to the demo board ([docs/LIVE-CUTOVER.md](docs/LIVE-CUTOVER.md)). What
did not match this file, and why:

| checked | found | matches DEMO.md? |
| --- | --- | --- |
| `/driver`, `/dispatcher`, `/technician` | all 200; each pre-fills the main seed's email | yes |
| sign in as `dispatch-ops@zippy.internal` with `SEED_PASSWORD` | OK | n/a — the deployed board is still the FULL seed, so the `demo-*` accounts this file uses do not exist there yet |
| `GET /queue`, `GET /jobs`, `GET /events` | 200, all empty | yes for an unused board |
| `GET /health` banner | **DEGRADED: "Running degraded: Crew on shift. Nothing can be dispatched until this clears."** — 7 of 24 crewed units on shift | **no** — this file promises no banner. The full seed writes shifts as clock times, which lapse; that is exactly what `DEMO_MODE` and the fifteen-minute refresh fix |
| `GET /health` `routing` field | absent | **no** — the deployed build predates `ROUTING_MODE`; present after the next deploy |
| `/chaos`, `POST /chaos/reset` | 404 | yes — not mounted in production |
| Steps 1-5 in a browser | **not walked** | the walk was read-only by instruction, and the demo board is not deployed yet. Re-walk after the cutover |
