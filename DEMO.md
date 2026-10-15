# DEMO.md — one breakdown, three windows, start to dispatched

The minimal live demo: a flat battery reported by a driver, planned by the
dispatcher, offered to a technician, accepted. One zone, one crew, one van.

This is the short demo. `WALKTHROUGH.md` is the long one against the full
24-unit board, and `DEMO_SCRIPT.md` is the presentation script with nine beats.
This file is the one you run when you want to see a dispatch work.

**Every step below was walked over the real HTTP API before it was written
down.** The responses quoted are what the endpoints actually returned, not what
they ought to.

---

## 0 — Before you open a browser

```bash
docker compose up -d postgres redis osrm   # osrm is optional — see below
bash scripts/demo-reset.sh                 # DROPS THE DATABASE, then seeds the demo board
npm run dev                                # window 1 — http://localhost:3000
npm run dev:worker                         # window 2 — the offer-expiry timer lives here
```

`demo-reset.sh` finishes by running `scripts/demo-dry-check.ts`, which prints
the diagnosis the demo answers produce and the feasibility verdict per option.
**It exits non-zero if nothing is feasible**, so a board that cannot dispatch
fails there rather than in front of an audience. The lines that matter, as it
actually printed them:

```
  contending faults (to 80% mass): FLAT_BATTERY, FAILED_BATTERY
  required capabilities:           BATTERY_REPLACEMENT, JUMP_START
  needs a tow (so a workshop):     no
  FEASIBLE  unit=demo-unit crew=demo-technician travel=1.0min covers=80% degraded=false
READY — at least one crew can take this job. The demo will dispatch.
```

(`degraded=true` there means OSRM is not running — see below. It does not stop
the demo.)

It also prints a one-line census of the board and every unit's capabilities;
after a clean reset that census is one zone, one technician, one shift, one
unit and no jobs waiting.

**The worker must be running.** A technician offer expires in 45 seconds
(`DEFAULT_OFFER_TTL_MS`) and the expiry job lives in the worker process. Without
it an offer never times out, which hides a real behaviour rather than breaking
the demo — but the health loop is in there too, so the dispatcher's banner will
be wrong.

### `degraded=true` in the dry check, and how to clear it

That flag is about **routing, not health**. Every OSRM call in
`src/infra/routing.ts` is wrapped: unreachable, non-200, bad code or timeout all
fall back to a haversine estimate inflated by a road factor, and the result
carries `degraded: true` rather than being silently substituted. With port 5001
refusing, that is the only thing the flag means.

```bash
docker compose up -d osrm      # ~17s to answer; the extract is already built
```

Measured on this board, same job, same crew:

| | travel estimate | flag |
| --- | --- | --- |
| OSRM down | 1.7 min (straight line × 1.4 road factor, 30 km/h) | `degraded=true` |
| OSRM up | **1.0 min** (real route: 698.7 m, 62.1 s) | `degraded=false` |

The demo dispatches either way. Starting OSRM is the difference between a real
road time and a defensible guess, which matters if anybody asks how travel time
is computed.

If OSRM has never been built on this machine, run `scripts/setup-osrm.sh` once
first — the container only *serves* a preprocessed extract, it does not build
one.

### What the health banner will show

**A fresh reset board shows no banner at all.** The banner is invisible when
everything is NORMAL, by design — a permanent green bar is furniture that stops
being read. All seven components come up NORMAL: `CREW_ON_SHIFT` reads "1 of 1
crewed units have a technician on shift", nothing is on a job, and there are no
payments yet.

**OSRM being down does not appear on the banner.** There is no routing component
on the ladder — the seven are `AI_EXTRACTION`, `GPS`, `WEBSOCKET`, `SOLVER`,
`PAYMENTS`, `CREW_ON_SHIFT` and `DISPATCH_CORE`. A permanently degraded routing
layer therefore looks healthy on screen, which is a real gap and not something
this demo papers over.

**Two components will turn the banner amber if you leave the board sitting**,
both only after the technician has accepted:

| component | fires after | why, on this board |
| --- | --- | --- |
| `PAYMENTS` | **10 min** (`PAYMENT_PENDING_AFTER_MS`) | accepting creates a callout authorisation; with no reachable payment provider it stays `PENDING_AUTHORISATION`, and dispatch is never blocked on it |
| `GPS` | **15 min** (`POSITION_STALE_AFTER_MS`) | the probe only looks at units on an active job, and nothing in this demo reports a new position after the seed stamps one |

So: **run the demo within about ten minutes of the reset and the banner stays
clean.** Past that, both messages are accurate reports about a board nobody is
touching rather than faults to fix. `CREW_ON_SHIFT` will not degrade — the shift
runs for eight hours.

To get back to NORMAL after either: `bash scripts/demo-reset.sh`.

### The three windows

| window | URL | email | what it is |
| --- | --- | --- | --- |
| Driver | http://localhost:3000/driver | `demo-driver@zippy.internal` | Asha Rao, whose Swift will not start |
| Dispatcher | http://localhost:3000/dispatcher | `demo-dispatcher@zippy.internal` | the board |
| Technician | http://localhost:3000/technician | `demo-tech@zippy.internal` | Ravi Kumar, in van DMO-V1 |

Password for all three: `password-dev-only`. **Each page pre-fills the MAIN
seed's account, not the demo one** (`driver-metrocab-1@`, `dispatch-ops@`,
`tech01@`), so replace the email with the one above before signing in.

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
this crew holds `JUMP_START`, `BATTERY_REPLACEMENT` and `OBD_DIAGNOSTICS`, not
`KEY_PROGRAMMING` or `ALTERNATOR_REPLACEMENT`. Answer it as a different fault
and the one van on the board is correctly rejected `CAPABILITY_MISSING`.

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
The last stage line carries the wall clock; on a one-van board there is very
little to do, so read it off the screen rather than expecting a figure.

Then **four plan cards** appear: `FASTEST_RESOLUTION`, `LOWEST_COST`,
`BALANCED`, `PROTECT_CONTRACTS`. On a one-van board all four choose the same
crew, which is itself worth saying out loud: the plans differ in what they
trade, and with one van there is nothing to trade.

Press **"Why this technician?"** on the job to open the **inspector**.

**Expect:** the cost breakdown term by term for the chosen option, and every
rejected option with the reason code that rejected it. On this board there are
no rejections to show, because there is one crew and it is feasible.

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
  safety change"**, naming the crew it would move the job **to**.

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
| 2 (plan recorded) | unchanged | four plan cards, **decision recorded** | **still empty** |
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
window has passed. The minimal seed computes it relative to *now*, so the fix is
to run `npm run db:seed:demo` again — it moves the window forward and changes
nothing else.

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

**One van means one job.** Invariant 7 is one active job per unit, so once the
demo job is `COMMITTED` the van is `ON_JOB` and a second job cannot be
dispatched to it. To run the demo again, run `bash scripts/demo-reset.sh` from
the top.

**`npm run db:seed:demo` refuses to run while the van has a live job**, and
tells you to use the reset instead:

```
refusing to re-seed: the demo van (demo-unit) still has 1 live job.

Forcing it back to AVAILABLE would not close it, and the next
dispatch would put a second active job on one van — invariant 7.

    cmv8hdak30194oqiovzdliqw1  COMMITTED

Run `bash scripts/demo-reset.sh` to start over. It drops the database
first, so this check passes and the board comes back clean.
```

The guard runs before any write, so a refusal leaves the database exactly as it
was — verified by checking the shift window had not moved. It exists because
the un-guarded version did real damage: re-seeding forces the van back to
`AVAILABLE` without closing its job, so the next dispatch put a **second active
job on one unit** — invariant 7 broken by the fixture rather than by the
product. Observed as two holds 46 seconds apart, both consumed, with a re-seed
between them.

`demo-reset.sh` is unaffected: it drops the database before it seeds, so there
is no job for the guard to find.

**Re-running the seed on a free van is still a no-op plus a fresh shift window**
— that is the supported way to fix a lapsed shift without losing the board.

**Getting the big board back:** `npm run db:reset` rebuilds the full 24-unit
seed. The demo seed never modified it — `prisma/seed.ts` and
`prisma/seed/demoMinimal.ts` are independent entry points, and the evaluation
harness and test suites still read the main one.
