# WALKTHROUGH.md

Drive one breakdown from "my car won't start" to "the technician has been paid",
in your own browser, across all four surfaces at once.

This is not the twelve-minute demo — that is `DEMO_SCRIPT.md`, and it is written
to be performed. This is written to be **checked**. Every step says what should
happen and where, so that when something does not happen you notice.

> **When something does not match: write it down and carry on.** Do not stop to
> fix it, and do not reload to see if it fixes itself unless the step says to.
> A list at the end is worth far more than one bug found and six missed. There
> is a page at the bottom to write on.

---

## 0 — Put the fleet on shift. Do this first, every time.

```bash
npx tsx scripts/demo-open-shifts.ts
```

**Expect:** `widened 31 shifts; 31 technicians are on shift until <a time
twelve hours from now>`.

**Run it even though it was run when this was set up**, and run it again every
time you come back to the walkthrough. It is not a caveat, it is step one, and
it is not optional.

Here is why. The seed gives every technician a realistic shift band — morning,
day, evening, or one of the four night crews — so how much of the fleet is
available depends on what time you sit down. Measured on this board at 23:50
IST: **four of the thirty-one technicians were on shift, and 22 of 24 jobs came
back unassignable.** Every plan is empty, the inspector has nothing to show, and
nothing in the interface tells you the reason is the clock. After running the
script the same board produced 333 feasible options.

The bands are correct and they stay: the evaluation harness fixes its own clock
and needs them. They are simply wrong for a person driving the product at an
arbitrary hour, and this script is the workaround.

**You no longer have to guess when this is the problem.** The dispatcher's
health banner now reports it: *"Running degraded: Crew on shift. Nothing can be
dispatched until this clears"*, with the count underneath — *"1 of 24 crewed
units have a technician on shift"* — and, on a seeded build, this script's name.
If you see that banner, you skipped this step or the window expired.

**If the walkthrough stops working part-way through**, check this first:

```bash
docker exec zippy-postgres-1 psql -U postgres -d zippy -c   "select count(distinct technician_id) as on_shift from technician_shifts    where starts_at <= now() and ends_at >= now();"
```

Fewer than about twenty and the board is starved. Re-run the script.

---

## 0b — What else is already set up

Everything below was done for you and both processes are running. You should
not have to type anything else before Step 1.

| what | state |
| --- | --- |
| Postgres, Redis, OSRM | `docker compose up -d`, all three up |
| database | reset, reseeded, Redis flushed |
| fleet history | `scripts/demo-prep-beat9.ts` — three RESOLVED battery jobs on `KA01AB1001` |
| board | 21 pending jobs — 4 routine, 10 elevated, 7 high risk — all raised in the last half hour, plus 3 resolved for the fleet history |
| action queue | empty when handed over; it grows an `ESCALATE_SLA_WINDOW_CLOSED` card per job as the board ages — see the note in Step 6 |
| simulator | not running; no orphaned process |
| web | `npm run dev` — http://localhost:3000 |
| worker | `npm run dev:worker` |

**To start the whole thing over from scratch** — the shift step is in here too,
in the position it has to be in: after the seed, before anything is dispatched.

```bash
docker compose up -d
npm run db:reset                                      # drops and reseeds
docker exec zippy-redis-1 redis-cli FLUSHALL          # stale BullMQ queues
npx tsx scripts/demo-prep-beat9.ts                    # fleet history
npx tsx scripts/demo-open-shifts.ts                   # everybody on duty — REQUIRED
npx tsx src/sim/cli.ts --rate 45 --duration 28 --max-jobs 22 --seed 11   --start "$(node -e "console.log(new Date(Date.now()-30*60000).toISOString())")"
npm run dev                                           # and, separately:
npm run dev:worker
```

The `--start` matters too. Without it the simulator dates its jobs 2026-06-01,
every SLA window on the board has closed, and the dispatcher's action queue
opens with twenty escalations you have to scroll past to find yours.

---

## 1 — Open four windows

Four **separate windows**, not four tabs. The whole point is watching one action
land in the others, and you cannot see that in a tab you are not looking at.
Arrange them so all four are visible at once — the dispatcher wants the most
room, the driver and technician the least.

| surface | URL | email (pre-filled) |
| --- | --- | --- |
| Driver | http://localhost:3000/driver | `driver-metrocab-1@zippy.internal` |
| Dispatcher | http://localhost:3000/dispatcher | `dispatch-ops@zippy.internal` |
| Technician | http://localhost:3000/technician | `tech01@zippy.internal` — **you will change this** |
| Fleet | http://localhost:3000/fleet | `fm-metrocab@zippy.internal` |

Every account uses the password `password-dev-only`, and every sign-in page
arrives with both fields filled. Signing in is one click on **Sign in**.

**Sign in to the driver, dispatcher and fleet windows now. Leave the technician
window on its sign-in page** — you do not yet know which technician you will be.

**Expect:** each window's "No connection" badge disappears once there is a
session, and the connection dot beside the wordmark goes green.

---

## 2 — Report a breakdown, as the driver

**Driver window.**

0. **You will be asked "Which car do you mean?" first.** Every seeded driver
   has jobs on the prepared board, so the page offers to resume one. Press
   **A different car has broken down** to get to the request flow. (Resuming an
   old job is worth trying once, separately — it used to leave the page frozen
   and now does not; see the fixed list at the bottom.)
1. The next screen is **"What has happened?"** with a free-text box. Type
   something plain — *"car won't start, no lights at all"* — and press
   **Continue**.
   **Expect:** *"Reading what you wrote…"* for a moment, then the symptom
   screen with **"It will not start"** already lit and a sentence above it
   saying what was read. If the model is unavailable you get an amber
   *"Our assistant is unavailable right now"* box instead and the keyword
   fallback lights the same button — that is a working degraded path, not a
   failure. Either way, carry on.
2. **"Which vehicle?"** — the dropdown lists number plates, not ids, and it
   should hold exactly one: `KA01AB1001`. It used to offer `KA01AB1002` as
   well, which belongs to the other Metrocab driver and which intake then
   refused. **If you see two plates here, write it down** — that is a
   regression.
3. Answer or skip the follow-up question, then the safety screen. **Leave every
   box unchecked** except *"I am on my own"*. You want a routine job to start
   with — you will make it urgent later, on purpose.
4. Location: press **"Use my current location"** if you like (the browser will
   ask), then pick **"On a service road or side street"**, type a landmark, and
   press **Send for help**.
   **Expect:** the stepper reads *Step 1 of 4 … Step 4 of 4* as you move. The
   **Send for help** button is disabled until a road position is picked — that
   is deliberate, not a stuck button.

**Expect, immediately after Send:** the driver window switches to the live
panel, and subscribes to the job's live feed as it does so. A headline like
*"We are finding someone equipped for this."*, a **Progress** list on the right
(below the hero on a narrow window) with the first stage ticked, and a green
**"Please move somewhere safe"** guidance card.
No map yet — nobody is coming yet, and a map with one dot on it would be a map
about nothing.

---

## 3 — Watch it arrive on the dispatcher's queue

**Dispatcher window. Do not reload it.**

**Expect, within a second of pressing Send:**

- **Active incidents** in the strip at the top goes up by one.
- A new row appears at the **top of the PRIORITY QUEUE** on the left, carrying
  `KA01AB1001`, the believed fault in words, and how long it has waited.
- A run of rows appears at the top of the **INCIDENT TIMELINE** in the centre —
  `JOB_CREATED`, `INTAKE_*`, `HYPOTHESIS_*`.

If the queue does not move, that is the thing to write down. Reload only after
you have written it down, and note whether the reload fixed it — "only after a
reload" is a different bug from "not at all".

---

## 4 — Solve

**Dispatcher window.**

Press **Solve — plan every pending job**.

**Expect:**

- A summary line beside the button: *N jobs · N options · N feasible · Nms*.
  With this board, 22 jobs (the 21 waiting plus yours) and several hundred
  options.
- Four plan cards underneath: **FASTEST_RESOLUTION**, **LOWEST_COST**,
  **BALANCED** (marked `RECOMMENDED`), **PROTECT_CONTRACTS**, each with a
  `TOTAL` and a per-job unit and cost.
- `SOLVER_RUN_*` and per-job rows in the timeline.

Press **Record this decision** on **BALANCED**. It is one click; the other
three demand a typed override reason first, and refuse without one.

**Expect:** the card's button reads *decision recorded*, a `PLAN_SELECTED` event
lands in the timeline, and a line under the cards says what just happened —
*"Recording a decision does not dispatch anybody"*. The button used to say
"Select this plan", which is what made an earlier run reasonable to read as
broken dispatch. It records the choice and why, against every job in the plan.
Nobody is reserved. Step 6 is where that happens.

---

## 5 — Read which technician was chosen

**Dispatcher window.**

Click your job's row in the priority queue (or its id in the timeline).

**Expect:** the right-hand **SELECTED JOB** column expands from a narrow rail
into a full column — on a window narrower than 1440 it is a wide band under the
board instead. Inside it, **WHY THIS TECHNICIAN?**:

- a header naming the believed fault distribution and the capabilities required;
- the **chosen** crew, with its unit code and technician;
- the cost breakdown, term by term — `expectedTimeToResolution`, `slaRisk`,
  `travelDistance`, `operationalCost`, `partSourcingCost`;
- underneath, the **rejected** options with their reason codes. Usually one of
  them is a *closer* van that was turned down for capability. That inversion is
  the product.

**Write down the technician id it names** — `tech-07`, `tech-19`, whatever it
is. It changes every run.

> **Hold on to it, but do not sign in as them yet.** In the next step the plan
> is re-solved and the crew may well change. The technician you actually want
> is the one named in Step 7.

---

## 6 — Make it urgent, and make an offer happen

Selecting a plan **records the decision; it does not reserve anybody.** Nothing
has been offered to any technician yet, and the technician window is still
empty. That is the design — the reservation is a separate, human-taken step —
but it means the offer has to be triggered.

The honest way to trigger it, entirely from the UI, is for the driver's
situation to change.

**Driver window.** Scroll to **Messages** and send:

> `I have had to move into the traffic lane, cars are going past me`

**Expect, within a second:** a bordered amber card appears on the driver's own
screen asking **"Are you blocking moving traffic?"**, with a line underneath
saying what answering costs and buys. It is on the *driver's* screen and not the
dispatcher's on purpose — the driver is the only person who can see the traffic.

Press **Yes**.

**Expect:**

- Driver: an update line — *"You told us your situation is more urgent. We have
  moved your job up the queue."*
- Dispatcher: the job's queue row gains a red **HIGH RISK** badge and jumps to
  the top; `SAFETY_LEVEL_CHANGED` lands in the timeline.
- Dispatcher: a new card appears in the **ACTION QUEUE** on the left —
  `Recommended · REASSIGN_AFTER_TRIGGER`, reason *"confirmed from a message:
  safety change"*, showing the crew it would move the job **from** and **to**.

> **If no crew can take the job you will now be told so.** A re-solve that
> finds nothing raises a `Recommended · No crew can take this job` card whose
> reason line carries the breakdown — *"found no crew: NO_TECHNICIAN_ON_SHIFT
> x23, SLA_UNREACHABLE x1"* — and a `NO_FEASIBLE_PLAN` row lands in the
> timeline. That used to be completely silent: the solver worked out exactly
> why and told nobody. If you see that card instead of the reassignment one,
> read the codes; it is almost always Section 0.

> **The action queue will not be empty, and that is not a fault.** The board was
> generated half an hour before it was handed to you and it keeps ageing, so a
> sweep raises one `ESCALATE_SLA_WINDOW_CLOSED` card per job whose SLA window
> has closed — five of them within an hour, more if you leave it overnight.
> Those are the commercial follow-up on a late job and they do not block
> dispatch. **Yours is the only card that says `REASSIGN_AFTER_TRIGGER`**, and
> it is the only one naming a crew under **from** and **to**. If the list is
> long, that is what to look for. Regenerating the board (Section 0b) empties
> the queue again.

---

## 7 — Reserve the crew, then be that technician

**Dispatcher window.** On that reassignment card, note the technician it names
under **to** — *this* is the one you will sign in as, and it may not be the one
from Step 5.

**Before you press anything:** go to the technician window and sign in as them.
The offer expires in **45 seconds** and cannot be answered from an offline
queue, so have the window open and signed in first.

Technician logins are `tech01@` … `tech31@zippy.internal`, and the id maps
straight to the number — `tech-07` is `tech07@zippy.internal`. The full table is
at the bottom of this file.

**Expect on the technician window after signing in:** the app bar shows a green
**On duty** pill, and the page says *"No job in hand right now."*

Now, **dispatcher window**, press **Execute** on the reassignment card.

**Expect, within a second and without reloading:**

- Technician: a **NEW JOB OFFERS** card appears with the vehicle, the zone, the
  landmark, a safety badge, and a countdown reading *"45 seconds left to
  answer"* that ticks down. Under fifteen seconds the card turns red.
- Dispatcher: the action card disappears from the queue;
  `TECHNICIAN_OFFER_SENT` lands in the timeline.

Press **Accept**.

**Expect:**

- Technician: the offer card is replaced by the job card — vehicle and plate,
  the **rung track** (five segments, first one filled, *"Assigned to you · 1 of
  5"*), the driver's name with **call** and **navigate** buttons, and a map. On
  a window wider than 1024 the map sits **beside** the card and the primary
  action sits under it; below 1024 they stack.
- Driver: *"<Name> is on the way."* with the person's name and a call button —
  **within a second, without reloading**. This is the single most important
  thing on this page to check.
- Dispatcher: `TECHNICIAN_OFFER_ACCEPTED`, `SAGA_COMMITTED`, `UNIT_HELD`.

---

## 8 — Walk the ladder

**Technician window.** Press the one amber button at a time. After each press,
**look at the driver window** before pressing the next.

| you press | driver's headline becomes | measured |
| --- | --- | --- |
| **I am on my way** | *unchanged* — see below | — |
| **I have arrived** | *"<Name> has arrived and is with your vehicle."* | 61 ms |
| **Start diagnosing** | *"<Name> is checking what is wrong."* | 45 ms |
| **Start work** | *"<Name> is working on your vehicle now."* | 57 ms |

> **"I am on my way" does not change the driver's headline, and that is
> correct.** Accepting the offer already said *"<Name> is on the way."*, so the
> sentence is the same one. What DOES move is the technician's rung track, the
> driver's **Progress** list, and both **What has happened** lists. Do not write
> this one down.

**Expect at every rung:** the driver's card changes without a reload — the
figures above are what it measured here, so anything you can perceive as a
*wait* is worth writing down; the technician's rung track advances one segment
and its label counts *2 of 5 … 5 of 5*; a line is added to both **What has
happened** lists; and a row lands in the dispatcher's timeline.

**Expect on the technician's phone-width window:** the button is pinned to the
bottom of the screen and stays there as you scroll. On a laptop-width window it
is not pinned — it sits in the right-hand column under the map, which is where
your eye already is.

---

## 9 — Send a cost, and approve it

**Technician window.** Under **FOUND SOMETHING DIFFERENT?**, press **Send the
driver a cost**.

**Expect on the technician:** the primary action is replaced by an amber
**"Paused — waiting on the driver"** block naming the amount, and a
**THE COST SENT TO THE DRIVER** block appears with the itemised lines. There is
now nothing to press — correct, because nothing the technician does moves this
forward.

**Expect on the driver, within a second:** a **What this comes to** card with
the lines itemised, then three rows: *Work and parts*, *Covered by your
contract*, and **You pay**.

> `driver-metrocab-1` is a **contract** customer, so the whole bill is absorbed
> and **You pay ₹0**. That is the interesting case — the middle line is what
> turns a bill into an explanation. If you want to see a driver who actually
> pays, run the whole thing again as `driver-walkin-1@zippy.internal`, who has
> no contract.

**Driver window:** press **Approve this cost**.

**Expect:**

- Driver: the approve/decline buttons disappear, and **only now** does the
  amber **Your completion code** card appear with a six-digit code. The code
  does not exist before approval — if you saw one earlier, write that down.
- Technician: the pause clears; the card now asks
  **"Before you finish — did you fit anything from the van?"** with two buttons.

---

## 10 — Finish the job

**Technician window.** Answer the parts question — **"Nothing from the van"** is
the quick path; **"Yes — let me record it"** lists what is actually on board and
lets you tap *Fitted one*, which is worth seeing once.

**Expect:** the completion-code box appears, with a sentence saying what
entering the code *does* — for a fully covered job, *"The driver pays nothing —
their company pays."*

Read the six digits off the driver's window, type them in, press **Finish job**.

**Expect:**

- Technician: the job card is replaced by *"No job in hand right now."*
- Technician: the **TODAY** block updates — **Earned today** goes from ₹0 to a
  real figure (about ₹321 on a job like this) and *"1 job finished"*.
- Technician: open **WHAT I AM OWED**. The balance matches, with a sentence
  explaining that payouts start at ₹500 so this one rolls over.
- Driver: the code card and the estimate card disappear; the headline becomes a
  finished-job sentence and the progress list is fully ticked.
- Dispatcher: `JOB_RESOLVED`; the row leaves the priority queue; **Active
  incidents** drops by one.
- **Fleet window:** press **Refresh**. The job moves out of **ACTIVE INCIDENTS**
  and into **PER-VEHICLE INCIDENT HISTORY** under `KA01AB1001`, with an SLA
  outcome of *met* or *breached*. **Mean resolution time** and **Spend this
  month** both move.

The fleet window is the one surface with no live socket — it is a summary a
person checks, not a feed, so **Refresh** is the only way it updates. If you
were waiting for it to change on its own, that is why.

---

## 11 — Things worth breaking on purpose

Do these **after** the run above, not during it. Each one is a separate short
experiment, and `Reset everything` puts the system back.

**The chaos panel** is on the dispatcher, at the bottom, inside
**Fleet reference — scarcity, every job, and the break-it panel** →
**Chaos controls**. It only renders because this is a dev build; a production
build does not serve the route at all.

Four switches, which stay on until you turn them off:

| switch | what to look for |
| --- | --- |
| `LLM_DOWN` | Driver: the free-text box still works, then shows *"Our assistant is unavailable"* and falls back to the keyword rules. The job is still created. |
| `WEBSOCKET_DOWN` | Every surface's connection dot goes grey and the field surfaces say so. Nothing updates live any more — this is the fastest way to prove the live updates in steps 7 and 8 were real and not you reloading. |
| `SOLVER_TIMEOUT` | Press **Solve**. The planner hits a 200ms deadline, plans what it reached, and the degradation banner at the top turns the SOLVER component amber. The jobs it did not reach keep the assignment they had. |
| `REDIS_DOWN` | Queues stop draining. The health banner says which component is degraded. |

Four one-shot actions:

| action | what to look for |
| --- | --- |
| **Take a technician offline** | Their shift is ended, not deleted. The zone re-plans. Jobs that only they could serve come back `NO_TECHNICIAN_ON_SHIFT` — the fastest way to see an escalation card with a real reason on it. |
| **Break a unit** | The van goes to MAINTENANCE and the zone re-plans. |
| **Force a destination decline** | Only does anything on a job that has a workshop destination — a tow. |
| **Inject 5 jobs** | Goes through real intake. The queue and the stat strip both move. |

**Reset everything** returns the switches to off. It does not un-break the rows
the one-shot actions changed — for that, re-run the prep block in Section 0.

### Going offline mid-ladder

Do this between two rungs, with a job in hand.

1. Technician window → DevTools (F12) → **Network** tab → set throttling to
   **Offline**.
2. **Expect:** a red **No signal** pill appears in the app bar.
3. Press the next rung button.
4. **Expect:** a toast at the bottom of the screen with an amber icon saying the
   action is queued, and an amber banner reading *"1 action is waiting to send.
   They will go in order as soon as you are back online."* The rung track does
   **not** advance, and the driver's window does **not** change.
5. Press one or two more things. **Expect:** the count goes up; the order is
   preserved.
6. Notice what is disabled: **Tell us what you found** and **Send the driver a
   cost** are greyed out with a sentence explaining why — re-diagnosing triggers
   a re-solve on the server and replaying that from a queue would raise a second
   recommendation for a decision somebody may already have taken. An offer, if
   one arrives, says it cannot be answered offline at all.
7. Set throttling back to **No throttling**.
8. **Expect:** the banner changes to *"Sending N actions…"*, the queue drains in
   order, the rung track catches up in one jump, and the driver's window catches
   up with it. A short list under the banner reports what each queued action
   came back with — a tap the server *refused* and a tap that *worked* look
   identical otherwise, and only one of them means do it again.

### Backdating a position, to see the staleness note

The map on the driver's screen only draws the technician's dot once a position
has been recorded for their van, and status taps carry one only if the browser
gave the technician window location permission. This cannot be done from the UI
at all, so:

```bash
# 1. Put the van somewhere, with a fresh timestamp. Replace UNIT-13 with the
#    unit code on the technician's own screen (bottom right of MY VAN).
docker exec zippy-postgres-1 psql -U postgres -d zippy -c \
  "update units set lat=12.9432, lng=77.6165, last_location_at=now() where code='UNIT-13';"
```

Reload the driver window. **Expect:** a second, amber, ringed dot on the map —
the crew — and no note underneath it. A fresh fix says nothing, because the dot
is as good as live.

```bash
# 2. Now age it past the threshold (15 minutes).
docker exec zippy-postgres-1 psql -U postgres -d zippy -c \
  "update units set last_location_at = now() - interval '20 minutes' where code='UNIT-13';"
```

Reload the driver window. **Expect:** the crew's dot is drawn **faded**, and the
line under the map turns amber and reads *"This is their last known position,
not where they are now."* Between two and fifteen minutes it reads
*"Last seen N minutes ago"* instead — try `interval '6 minutes'` for that one.

**Do this while the technician is EN ROUTE, not on site.** Once they have
arrived the map stops answering a question — their dot and the driver's are the
same place — so the whole thing is suppressed on purpose.

---

## 12 — The four widths

If you are also checking the responsive work, the fastest pass is one window
resized rather than four. Chrome DevTools → device toolbar → type the width in.

| width | driver / technician | dispatcher | fleet |
| --- | --- | --- | --- |
| 390 | one column, sticky bottom action bar | one column, priority queue first | metric tiles one-up, incidents as stacked cards |
| 768 | one column, capped around 640px wide | one column | tiles two-up |
| 1024 | **map beside the job details**, person card and action side by side | two columns, investigate as a band under the board | tiles three-up |
| 1440 | same two columns, wider | three columns, investigate as a rail until a job is picked | tiles five-up |

Nothing on any surface at any of those widths should scroll sideways. The
dispatcher's wide tables scroll **inside their own card** on a phone; if the
whole page slides under your thumb, that is a bug.

---

## The seeded technicians

Every one of these uses the password `password-dev-only`. The **id** is what the
dispatcher's inspector and the action card name; the **email** is what you type.
Technicians 25–31 have no van, so they are never offered a job.

| id | email | name | van | home zone |
| --- | --- | --- | --- | --- |
| `tech-01` | `tech01@zippy.internal` | Ravi Kumar | UNIT-01 | Koramangala |
| `tech-02` | `tech02@zippy.internal` | Anil Shetty | UNIT-02 | Indiranagar |
| `tech-03` | `tech03@zippy.internal` | Suresh Nayak | UNIT-03 | Whitefield |
| `tech-04` | `tech04@zippy.internal` | Manjunath Rao | UNIT-10 | Jayanagar |
| `tech-05` | `tech05@zippy.internal` | Imran Khan | UNIT-11 | Hebbal |
| `tech-06` | `tech06@zippy.internal` | Deepak Reddy | UNIT-06 | Electronic City |
| `tech-07` | `tech07@zippy.internal` | Vijay Gowda | UNIT-07 | Koramangala |
| `tech-08` | `tech08@zippy.internal` | Prakash Hegde | UNIT-14 | Indiranagar |
| `tech-09` | `tech09@zippy.internal` | Naveen Bhat | UNIT-09 | Whitefield |
| `tech-10` | `tech10@zippy.internal` | Santosh Pai | UNIT-04 | Jayanagar |
| `tech-11` | `tech11@zippy.internal` | Arun Menon | UNIT-05 | Hebbal |
| `tech-12` | `tech12@zippy.internal` | Kiran Desai | UNIT-12 | Electronic City |
| `tech-13` | `tech13@zippy.internal` | Ganesh Iyer | UNIT-13 | Koramangala |
| `tech-14` | `tech14@zippy.internal` | Mahesh Patil | UNIT-08 | Indiranagar |
| `tech-15` | `tech15@zippy.internal` | Rakesh Jain | UNIT-15 | Whitefield |
| `tech-16` | `tech16@zippy.internal` | Sunil Verma | UNIT-16 | Jayanagar |
| `tech-17` | `tech17@zippy.internal` | Harish Acharya | UNIT-17 | Hebbal |
| `tech-18` | `tech18@zippy.internal` | Vinod Kamath | UNIT-18 | Electronic City |
| `tech-19` | `tech19@zippy.internal` | Rajesh Prabhu | UNIT-19 | Koramangala |
| `tech-20` | `tech20@zippy.internal` | Girish Rai | UNIT-20 | Indiranagar |
| `tech-21` | `tech21@zippy.internal` | Basavaraj Patil | UNIT-21 | Whitefield |
| `tech-22` | `tech22@zippy.internal` | Shivakumar Gowda | UNIT-22 | Jayanagar |
| `tech-23` | `tech23@zippy.internal` | Nagaraj Bhat | UNIT-23 | Hebbal |
| `tech-24` | `tech24@zippy.internal` | Yusuf Sheikh | UNIT-24 | Electronic City |
| `tech-25` | `tech25@zippy.internal` | Praveen Kulkarni | — | Koramangala |
| `tech-26` | `tech26@zippy.internal` | Dinesh Shenoy | — | Indiranagar |
| `tech-27` | `tech27@zippy.internal` | Ashok Naik | — | Whitefield |
| `tech-28` | `tech28@zippy.internal` | Lokesh Murthy | — | Jayanagar |
| `tech-29` | `tech29@zippy.internal` | Farhan Ahmed | — | Hebbal |
| `tech-30` | `tech30@zippy.internal` | Ramesh Poojary | — | Electronic City |
| `tech-31` | `tech31@zippy.internal` | Srinivas Char | — | Koramangala |

The two EV-certified technicians are `tech-01` and `tech-02`; the three who can
programme keys are `tech-01`, `tech-02` and `tech-03`. That scarcity is
deliberate and it is what makes the plan cards disagree with each other.

### The other logins

| role | email | page |
| --- | --- | --- |
| dispatcher | `dispatch-ops@zippy.internal` | `/dispatcher` |
| fleet manager | `fm-metrocab@zippy.internal` | `/fleet` |
| driver, contract | `driver-metrocab-1@zippy.internal` (`KA01AB1001`) | `/driver` |
| driver, contract | `driver-metrocab-2@zippy.internal` (`KA01AB1002`) | `/driver` |
| driver, walk-in | `driver-walkin-1@zippy.internal` (`KA04GH4001`) | `/driver` |

---

## Known before you start

Do not spend time writing these down again.

### Still true

1. **Recording a plan decision does not offer the job to anybody.** The
   reservation only starts from a `REASSIGN_*` action in the action queue,
   which needs a re-plan trigger — which is why Step 6 exists and why this is
   not simply "press Solve, then accept". This is a wiring gap rather than a
   design, written up in full at INTERVIEW.md §15.41: `src/api/solve.ts` still
   carries a comment saying holds and the saga are "Phase 11 and Phase 12…
   until they exist", and both shipped. **Five** job statuses are further
   evidence — `OFFERED`, `UNSERVICEABLE`, `AWAITING_DESTINATION` and `TOWING`
   have no writer at all, and `PLANNED` is only ever written by a compensation.
   All five have finished driver copy that can never appear.
   The console no longer implies otherwise; closing the gap is a product
   decision, not a refactor.
2. **Shifts are realistic, so the board is time-of-day dependent.** Section 0.
   `scripts/demo-open-shifts.ts` is a workaround, not a fix — but the banner
   now tells you when you need it.
3. **The fleet dashboard has no live updates.** Refresh is the only way.

### Fixed since this was written — check they stay fixed

4. **A driver who resumed a job used to get no live updates.** The window
   subscribed to the job's room only when it created the job; both restore
   paths set the active job, refetched once, and stopped — so a driver who
   signed in again, or simply reloaded, sat on a socket that said "Connected"
   and received nothing while their technician drove to them. It also loaded no
   messages. All three paths now go through one `openJob()` in
   `public/js/pages/driver.js`. Measured after the fix: 15 `job:event` frames
   where there had been 0, updates landing in 19–63 ms, and the message thread
   populated on resume.
   **To check it yourself:** mid-run, reload the driver window and press the
   job in "Which car do you mean?". Everything after that should still update
   live.
5. **The vehicle picker used to offer vehicles the driver could not file
   against.** `GET /vehicles` was scoped by tenant only while intake matched on
   `driverId`, so a Metrocab driver was offered both Metrocab cars and one of
   them failed. Both now read `vehicleFilingFilter` in `src/auth/permissions.ts`.
   A driver sees one plate; a fleet manager still sees their tenant's two; a
   dispatcher still sees all six.
6. **A re-solve that found no crew used to leave no trace.** No action, no job
   event, no log line — the reason an earlier run was read as broken dispatch.
   It now raises `ESCALATE_NO_FEASIBLE_PLAN` with the rejection breakdown and
   writes a `NO_FEASIBLE_PLAN` event. One card per job, not one per trigger.
7. **A coordinate anywhere on Earth used to be accepted.** `resolveZoneId` took
   the nearest zone with no maximum distance, so a genuine browser fix in Delhi
   was filed into a Bengaluru zone 1,742 km away and queued as servicable —
   then OSRM snapped it onto the Bengaluru road graph and returned a five
   minute drive. Intake now bounds it at 80 km and refuses in the driver's own
   words: *"We do not cover where you are yet. The nearest place we work is
   Bengaluru, about 1742 km away."*
   **To check it yourself:** on the location step, open *Enter coordinates
   manually* and type `28.696` / `77.207`.
8. **The dispatcher had no fleet-level signal for a staffing gap.** There is now
   a `Crew on shift` component on the health ladder — see Section 0.

---

## What did not match

| # | step | what you expected | what happened | which window |
| --- | --- | --- | --- | --- |
| 1 |  |  |  |  |
| 2 |  |  |  |  |
| 3 |  |  |  |  |
| 4 |  |  |  |  |
| 5 |  |  |  |  |
| 6 |  |  |  |  |
| 7 |  |  |  |  |
| 8 |  |  |  |  |
