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
docker compose up -d postgres redis     # OSRM is optional; see below
bash scripts/demo-reset.sh              # DROPS THE DATABASE, then seeds the demo board
npm run dev                             # window 1 — http://localhost:3000
npm run dev:worker                      # window 2 — the offer-expiry timer lives here
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
  FEASIBLE  unit=demo-unit crew=demo-technician travel=1.7min covers=80% degraded=true
READY — at least one crew can take this job. The demo will dispatch.
```

It also prints a one-line census of the board and every unit's capabilities;
after a clean reset that census is one zone, one technician, one shift, one
unit and no jobs waiting.

**The worker must be running.** A technician offer expires in 45 seconds
(`DEFAULT_OFFER_TTL_MS`) and the expiry job lives in the worker process. Without
it an offer never times out, which hides a real behaviour rather than breaking
the demo — but the health loop is in there too, so the dispatcher's banner will
be wrong.

**Without OSRM** every travel time falls back to a straight-line estimate and is
flagged degraded. The demo works; `degraded=true` in the dry check is expected
and is not a fault. Start it with `docker compose up -d osrm` if you want real
road times.

### The three windows

| window | URL | email | what it is |
| --- | --- | --- | --- |
| Driver | http://localhost:3000/driver | `demo-driver@zippy.internal` | Asha Rao, whose Swift will not start |
| Dispatcher | http://localhost:3000/dispatcher | `demo-dispatcher@zippy.internal` | the board |
| Technician | http://localhost:3000/technician | `demo-tech@zippy.internal` | Ravi Kumar, in van DMO-V1 |

Password for all three: `password-dev-only`. Every sign-in page arrives with
both fields filled, so signing in is one click on **Sign in**.

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

1. **"What has happened?"** → under *What's wrong with the vehicle?* choose
   **It will not start**. Press **Continue**.
2. **"Which vehicle?"** → pick **KA01DM0001** (White Maruti Suzuki Swift). It is
   the only one.
3. **"Are you safe where you are?"** → tick nothing. Press **Continue**.
4. **"Where are you?"** → under *Which best describes where the car is
   standing?* choose **In a car park or driveway**. Press **Continue**.

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
the plate `KA01DM0001`, a safety badge reading **NORMAL**, and its three sort
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

> `I have had to move into the traffic lane, cars are going past me`

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
on the board when the offer times out.

**The dispatcher's banner is red.** Read it — it names the component and what
the fallback is. `Crew on shift` degraded means the shift has lapsed; see above.

---

## Running it twice

**One van means one job.** Invariant 7 is one active job per unit, so once the
demo job is `COMMITTED` the van is `ON_JOB` and a second job cannot be
dispatched to it. To run the demo again, run `bash scripts/demo-reset.sh` from
the top.

**Do not run `npm run db:seed:demo` in the middle of a live demo.** It forces
the van back to `AVAILABLE` so a half-finished demo can be restarted, and it
does not close the job the van was on — so the next dispatch puts a second
active job on the same unit. That is invariant 7 broken by the fixture rather
than by the product, and it was observed exactly that way while this file was
being verified: two holds 46 seconds apart, both consumed, because a re-seed
landed between them.

**Getting the big board back:** `npm run db:reset` rebuilds the full 24-unit
seed. The demo seed never modified it — `prisma/seed.ts` and
`prisma/seed/demoMinimal.ts` are independent entry points, and the evaluation
harness and test suites still read the main one.
