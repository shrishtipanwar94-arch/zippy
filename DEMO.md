# DEMO.md — the six-act demo on the live board

One driver reports a breakdown; the solver weighs four crews and picks one;
that crew is offered the job, accepts, quotes, finishes and is paid; then a
second job is declined and moves on. Every job the driver reports lands on
crew B's screen.

`WALKTHROUGH.md` is the long tour of the full 24-unit board and
`DEMO_SCRIPT.md` the nine-beat presentation script. This file is the one you
run.

**What was verified, and how.** All six acts were walked **in a browser** on
2026-10-17, on a local copy of the live board (full seed + demo board, demo
mode, Razorpay test keys, the Groq assistant) — every screen described below
is what that walk showed. On the **deployed site**, `scripts/demo-dry-check.ts`
ran inside the web container and passed: every fault type through the real
routes to crew B's screen (10 of 11; the tow is a known limitation, below).
The deployed site has **not** been walked in a browser: Chrome on the
maintainer's machine showed a "Security error" page for the Railway domain
while the server answered normally.

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

**What the driver sees:** a diagnosis in plain words — "We are not certain
whether it is a flat battery or a battery that needs replacing, so we are
sending someone equipped for both." — the headline moving from "We are taking
down the details of your breakdown." to "**Finding someone equipped for
this.**", and a **Callout fee ₹300.00 · Pay now** panel (the pinned callout
price; optional at this point).

**Not built: a price range.** The driver sees the pinned callout fee (₹300)
and, later, the technician's itemised estimate — but no range up front.

## Act 2 — the dispatcher sees the choice

**Dispatcher window.** The job arrives in the **priority queue** by itself
("DL01DM0001 · a flat battery · ELEVATED · <your landmark> — Demo Zone"), and a
card lands in the **action queue**: **"Dispatch — intake is complete"**, reason
"intake complete: ready to dispatch", **sends: Ravi Kumar · DMO-VB**, with its
cost and expected resolution minutes. (Demo mode raises it; elsewhere the
system waits for a re-plan trigger.) No banner: the board is healthy.

Click the job in the queue to open the inspector, **"Why Ravi Kumar in
demo-unit-b?"**: B chosen; D feasible but dearer (it can do everything too — it
is just far); A rejected `CAPABILITY_MISSING` though it is nearest; C rejected
`PART_UNAVAILABLE` — the skill, not the part, and no depot to fetch one from.
Hard constraints are filters with reason codes, never penalties. (The heading
shows the unit's internal id rather than its code — cosmetic.)

## Act 3 — the offer, the accept, the ETA

**Dispatcher:** press **Execute** on the card. The van is **held**, not
assigned — a hold with a TTL, taken by a conditional update, so two dispatchers
cannot both win it.

**Technician window:** one offer — "Maruti Suzuki Swift · DL01DM0001 · Demo
Zone · <landmark>" — with a **45-second countdown**. Press **Accept**. Ravi's
screen shows "Assigned to you — Asha", "The part is in your van", and **I am on
my way**.

**Driver:** "**Ravi is on the way.**" — "About 5 minutes, roughly", "Ravi · a
flatbed tow truck" — the estimate is rough because production routing is
straight-line (`/health` says `routing.mode: HAVERSINE`). **Dispatcher:** the
card clears and the queue empties, live.

## Act 4 — the estimate

**Technician:** **I am on my way → I have arrived → Start diagnosing**, then
**Send the driver a cost**. Ravi's screen shows the cost sent (your time · 10
minutes ₹102, coming out to you ₹300, **the driver pays ₹402**) and "Paused —
waiting on the driver". **Driver:** the same lines with **Approve this cost** /
**Cancel the job**, plus the **completion code** to read out at the end.

**Pressing send twice, and approve twice, creates nothing new** (checked in the
database during the browser walk): one estimate issued, one approval, and the
job moves to WORKING.

## Act 5 — finish and pay

**Technician:** "Before you finish — did you fit anything from the van?" →
**Nothing from the van** (for a jump start), then **Ask the driver for their
6-digit code** → type it → **Finish job**. Ravi's screen: "**Earned today
₹321.60 · 1 job finished**". **Driver:** "**All done. Ravi has finished with
your vehicle.**", every progress step ticked.

**Payment — Razorpay test mode is on.** The driver pays the callout from the
**Pay now** panel, which opens Razorpay's test checkout ("Zippy · ₹300"). It
asks for a mobile number first and **rejects obviously fake ones** — use a
real-format number you are comfortable entering in test mode, then a Razorpay
test method. If the callout is not paid, completion still resolves the job and
pays Ravi (the ledger rows are written), but the capture fails
(`PAYMENT_CAPTURE_FAILED`) and "Pay now" stays on the driver's screen. (With
no Razorpay keys a stub provider authorises and captures instead — the manual
path.)

Crew B's van is free again the moment the job completes.

## Act 6 — declined, and it moves on

Report a second breakdown (Act 1 again). Execute its card. On the technician
window press **Decline** — or let the 45 seconds run out.

**Dispatcher** (live, no Refresh): two cards for that job — "**The crew for this
job did not hold — nobody is assigned**" (technician DECLINED) and "**Reassign —
a re-plan trigger fired**: offer declined: re-planned without the crew that
refused · **sends Meera Nair · DMO-VD**". The re-plan leaves out whoever
refused; that exclusion is the narration. **Driver:** "Still looking for a crew
for this." Nothing more appears when the 45 s deadline passes.

**Stop at the card.** Nobody can sign in as Meera, so executing it would send
an offer that can only time out. Leave the job: the worker retires it once it
has sat unassigned for an hour.

---

## Limitations — say them before you are asked

| | |
| --- | --- |
| **A tow cannot be dispatched** | "Stuck or damaged" diagnoses `IMMOBILISED_UNKNOWN`, which needs a tow. The solver chooses B, but Execute is refused: a tow's third leg needs a workshop to confirm the destination, and the product has no workshop participant (INTERVIEW.md 15.44). The card turns into "No crew can take this job". Avoid that complaint. |
| **No price range** before the estimate | see Act 1 |
| **Razorpay test checkout** | needs a real-format mobile number; an unpaid callout fails capture at completion and "Pay now" stays visible (Act 5) |
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
