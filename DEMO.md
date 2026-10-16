# DEMO.md — the six-act demo on the live board

One driver reports a breakdown; the solver weighs four crews and picks one;
that crew is offered the job, accepts, quotes, finishes and is paid; then a
second job is declined and moves on. Every job the driver reports lands on
crew B's screen.

`WALKTHROUGH.md` is the long tour of the full 24-unit board and
`DEMO_SCRIPT.md` the nine-beat presentation script. This file is the one you
run.

**What was verified, and how.** Acts 1, 2, 3 and 6 for every fault type are
checked by `scripts/demo-dry-check.ts`, which drives the real HTTP routes with
real sign-ins (10 of 11 fault types pass end to end; the tow is a known
limitation, below). Acts 3, 4 and 5 were walked once over the real routes on a
local copy of the live board. **None of the six acts has been walked in a
browser on the deployed site**; where a line describes what a screen shows
rather than what the API returned, it says so.

---

## The board

Turned on by `DEMO_MODE=true` (docs/DEPLOYMENT.md). The live database still
holds the full seed; demo mode hides it by filter, never by deleting.

| crew | who | vehicle | where | can do | carries | for any fault the driver reports |
| --- | --- | --- | --- | --- | --- | --- |
| A | Imran Sheikh | van DMO-VA | Janpath, ~0.6 km | jump-start only | nothing | rejected **CAPABILITY_MISSING** (for the tow: VEHICLE_TYPE_INCOMPATIBLE) |
| **B** | **Ravi Kumar** | flatbed DMO-VB | Gole Market, ~1.9 km | **everything** | **every part** | **chosen** |
| C | Gurpreet Singh | flatbed DMO-VC | Pragati Maidan, ~3.3 km | everything | nothing | rejected **PART_UNAVAILABLE** when a part is needed (9 faults); feasible but dearer when none is (lockout, tow) |
| D | Meera Nair | flatbed DMO-VD | Hauz Khas, ~7.4 km | everything | every part | feasible, about 20 cost points dearer — and where a declined job goes |

Only B can sign in. A, C and D are real technicians with no usable password.

**On the dispatcher's board: two jobs.** The one you create, and a reference
job — a flat tyre at Lodhi Garden, filed by a second (hidden) driver, offered
to B, declined, re-planned to D, finished by D. It was created through the real
path by the seed, so its inspector, timeline and payment are genuine.

---

## Before you start

**Three windows**, each on the deployed URL. Each page pre-fills its demo
account in demo mode; type the password (the deployment's `SEED_PASSWORD`).

| window | path | account |
| --- | --- | --- |
| Driver | `/driver` | `demo-driver@zippy.internal` (Asha Rao) |
| Dispatcher | `/dispatcher` | `demo-dispatcher@zippy.internal` |
| Technician | `/technician` | `demo-tech-b@zippy.internal` (Ravi Kumar, crew B) |

**Check the board first** (needs the Railway CLI and a registered SSH key):

```
railway ssh -s web -- npx tsx scripts/demo-dry-check.ts
```

It must end `PASS — crew B wins every fault type, end to end.` It files and
retires 11 real jobs on the live database (cancelled, never deleted), so run it
before the audience arrives, not during.

**Leave the technician window visible.** An offer lasts 45 seconds.

---

## Act 1 — the driver reports a breakdown

**Driver window.** On "What has happened?", type:

> my car will not start, I just hear a rapid clicking and the dashboard lights are very dim

and press the describe button. The assistant reads it (verified on the live
service: `WONT_START`, cranks `NO`, sound `CLICKING`) and **pre-selects "It will
not start"**. Continue through safety (leave the default), then location —
**leave the coordinate boxes alone** (they default to the demo zone; "Use my
current location" captures your real GPS and is refused outside Delhi) — and
press **Send for help**. Answer the follow-up questions; intake stops asking as
soon as more answers cannot change who is sent.

If the assistant is unavailable or capped, the screen says so in one sentence
and you answer the same questions by hand. Nothing else changes.

**What the driver sees:** the headline moves from "We are taking down the
details of your breakdown." to "Finding someone equipped for this."

**Not built: a pinned price range.** The job does pin a price list when it is
created, but the driver is not shown a range before the technician's estimate.
Say it rather than look for it.

## Act 2 — the dispatcher sees the choice

**Dispatcher window.** The board shows **two jobs**: yours and the reference
job. In the **action queue** a card appears by itself as intake finishes —
`REASSIGN_AFTER_TRIGGER`, reason **"intake complete: ready to dispatch"**,
naming **Ravi (crew B)**. (Demo mode raises it; elsewhere the system waits for
a re-plan trigger.)

Open **"Why this technician?"** on the job. *(Contents measured through the
engine and the API; not yet seen in a browser.)* B chosen; D feasible but
dearer (it can do everything too — it is just far); A rejected
`CAPABILITY_MISSING` though it is nearest; C rejected `PART_UNAVAILABLE` — the
skill, not the part, and no depot to fetch one from. Hard constraints are
filters with reason codes, never penalties.

## Act 3 — the offer, the accept, the ETA

**Dispatcher:** press **Execute** on the card. The van is **held**, not
assigned — a hold with a TTL, taken by a conditional update, so two dispatchers
cannot both win it.

**Technician window:** one offer with a **45-second countdown**. Press
**Accept**.

**Driver (verified over the API):** "**Ravi is on the way.**" with an arrival
estimate ("About 5 minutes") marked rough — production routing is
straight-line, not road (`/health` says `routing.mode: HAVERSINE`).
**Dispatcher:** the job leaves the queue; updates arrive live.

## Act 4 — the estimate

**Technician:** step through **On my way → Arrived → Diagnosing**, then send the
estimate. **Driver:** approve (or decline) it.

**Pressing send twice creates nothing new** (verified over the API): the second
send returns the same estimate and the job still has one; a second approval is
refused `409 already_answered`. Estimates are unique per priced inputs, enforced
in the database.

## Act 5 — finish and pay

**Technician:** **Working → Complete**. The driver's screen shows a completion
code to read out once the work is done; the technician enters it.

**Payment** (verified over the API, with the stub provider): the callout was
authorised when Ravi accepted, and completion captures the approved total
(₹402 for the flat battery) and posts it to the ledger. Ravi's earnings
statement (`/technician/earnings`, the technician's money panel) shows his
share — ₹321.60, held because payouts start at ₹500.

This is the **manual path**: with no Razorpay keys set, a stub provider
authorises and captures. With Razorpay keys set the driver is sent to
Razorpay's test checkout instead, and an unpaid checkout leaves the
authorisation pending (the payments banner turns amber after 10 minutes).
**Turn Razorpay off for this demo** (step 1 of docs/LIVE-CUTOVER.md).

Crew B's van is free again the moment the job completes.

## Act 6 — declined, and it moves on

Report a second breakdown (Act 1 again). Execute its card. On the technician
window press **Decline** — or let the 45 seconds run out.

**Dispatcher** (verified over the API): two cards for that job —
`ESCALATE_DISPATCH_REQUEUED` ("the reservation for this job did not hold
(technician DECLINED)") and a new `REASSIGN_AFTER_TRIGGER`, **"offer declined:
re-planned without the crew that refused"**, naming **Meera (crew D)**. The
re-plan leaves out whoever refused; that exclusion is the narration.

**Stop at the card.** Nobody can sign in as Meera, so executing it would send
an offer that can only time out. Leave the job: the worker retires it once it
has sat unassigned for an hour.

---

## Limitations — say them before you are asked

| | |
| --- | --- |
| **A tow cannot be dispatched** | "Stuck or damaged" diagnoses `IMMOBILISED_UNKNOWN`, which needs a tow. The solver chooses B, but Execute is refused: a tow's third leg needs a workshop to confirm the destination, and the product has no workshop participant (INTERVIEW.md 15.44). The card turns into "No crew can take this job". Avoid that complaint. |
| **No price range** before the estimate | see Act 1 |
| **Razorpay** | off for the demo; the stub provider is the manual path (Act 5) |
| **Routing is straight-line** | ETAs are rough and flagged so |
| **Cannot be shown live** | the concurrency suite (real Postgres races, `npm run test:concurrency`), the degradation banner and chaos panel (not mounted in production), and the evaluation benchmark (`npm run eval`). Show them locally. |

## If something goes wrong

- **No card after intake.** Intake is not finished — the headline still says
  "taking down the details". Answer the remaining questions.
- **The card names D, not B.** B is busy: on a job, or an offer to B is
  counting down. Finish or decline it; a stuck van is freed within 15 minutes
  by the worker, or immediately when a job completes.
- **"No crew can take this job".** Probably the tow; see Limitations.
- **The board shows more than two jobs.** An earlier demo job is still live —
  Act 6 leaves one, and so does walking away mid-act. Demo mode shows only live
  jobs and the reference job, and the worker retires any demo job left
  unassigned for over an hour (CANCELLED, never deleted), so it clears itself.
  Run Act 6 last, or allow an hour before the next audience.
