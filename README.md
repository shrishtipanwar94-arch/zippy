# Zippy

Roadside breakdown dispatch, optimised for **time-to-resolution** rather than
time-to-arrival.

The nearest technician often cannot fix the fault. Sending them is fast to
arrive and slow to resolve, because a second dispatch then has to happen. Zippy
plans against the probability distribution over what is actually wrong, sends a
crew who can cover the likely faults, and prices the risk of a wasted visit
directly into the objective function.

That claim is measured rather than asserted, and the measurement is in this
repository. Every number below comes from `npm run eval`, which replays seeded
scenarios through the production engine — the same `candidates.ts`,
`feasibility.ts`, `cost.ts` and `allocation.ts` the server uses. There is no
second implementation of the solver for benchmarking.

---

## The benchmark

Seed `20260901`, five scenarios, four policies. Two runs of the same seed
produce byte-identical output; this table was pasted from the second one.

| scenario | policy | resolved | stranded | 1st-visit | mean arrival | **mean resolution** | 2nd dispatch | SLA breach | utilisation | Gini |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normal-day | fifo | 58/60 | 0 | 96.7% | 39.9 min | 63.2 min | 3.3% | 12 | 14.5% | 0.686 |
| normal-day | nearest-unit | 58/60 | 0 | 96.7% | 28.0 min | 51.4 min | 3.3% | 6 | 13.0% | 0.631 |
| normal-day | skill-aware | 59/60 | 0 | 96.7% | 33.1 min | 57.8 min | 3.3% | 7 | 13.6% | 0.650 |
| normal-day | **capability-aware-global** | 59/60 | 0 | 96.7% | **24.8 min** | **49.2 min** | 3.3% | 3 | 12.3% | 0.630 |
| monsoon-surge | fifo | 97/180 | 77 | 94.2% | 166.4 min | 201.8 min | 1.9% | 149 | 29.9% | 0.468 |
| monsoon-surge | nearest-unit | 95/180 | 80 | 95.0% | 156.8 min | 193.8 min | 2.0% | 142 | 29.6% | 0.474 |
| monsoon-surge | skill-aware | **98/180** | 75 | 93.3% | 158.0 min | 192.7 min | 1.9% | 142 | 29.2% | 0.474 |
| monsoon-surge | **capability-aware-global** | 90/180 | 84 | 93.8% | **95.8 min** | **126.6 min** | 4.2% | 121 | 19.3% | 0.525 |
| capability-scarcity | fifo | **23/23** | 0 | 100.0% | 39.1 min | 65.2 min | 0.0% | 5 | 5.5% | 0.780 |
| capability-scarcity | nearest-unit | 22/23 | 0 | 95.7% | 31.3 min | 57.6 min | 4.3% | 4 | 6.1% | 0.723 |
| capability-scarcity | skill-aware | **23/23** | 0 | 95.7% | 32.1 min | 61.2 min | 4.3% | 4 | 5.3% | 0.756 |
| capability-scarcity | **capability-aware-global** | 22/23 | 0 | 95.7% | **30.1 min** | **56.3 min** | 4.3% | 4 | 6.0% | 0.713 |
| ambiguous-diagnosis | fifo | 29/60 | 31 | 100.0% | 150.1 min | 179.3 min | 0.0% | 51 | 8.2% | 0.847 |
| ambiguous-diagnosis | nearest-unit | **32/60** | 28 | 100.0% | 145.5 min | 175.0 min | 0.0% | 50 | 8.6% | 0.850 |
| ambiguous-diagnosis | skill-aware | **32/60** | 28 | 100.0% | 145.5 min | 175.0 min | 0.0% | 50 | 8.6% | 0.850 |
| ambiguous-diagnosis | **capability-aware-global** | 31/60 | 29 | 100.0% | **71.5 min** | **98.3 min** | 0.0% | 45 | 6.7% | 0.856 |
| technician-dropout | fifo | **59/60** | 0 | 96.7% | 64.9 min | 91.0 min | 3.3% | 28 | 14.4% | 0.679 |
| technician-dropout | nearest-unit | 58/60 | 0 | 96.7% | 66.4 min | 88.9 min | 3.3% | 32 | 14.0% | 0.688 |
| technician-dropout | skill-aware | **59/60** | 0 | 96.7% | 62.7 min | 87.7 min | 3.3% | 29 | 13.9% | 0.678 |
| technician-dropout | **capability-aware-global** | 58/60 | 0 | 96.7% | **56.8 min** | **81.2 min** | 3.3% | 18 | 13.3% | 0.677 |

### How to read it, including where it loses

**The headline result.** `capability-aware-global` posts the best mean
time-to-resolution in **all five** scenarios — and the best mean
time-to-*arrival* in all five too, which was not the expectation. The margin on
resolution ranges from 1.3 minutes (capability-scarcity) to 76.7
(ambiguous-diagnosis); the two scenarios where it barely wins are the two where
the fleet is not under pressure. It cuts SLA breaches in four of the five and
ties the best alternative in the fifth, most sharply at technician-dropout
(18 against 28).

**Where it loses, which matters more.** It resolves **fewer jobs** than the
best alternative in four of the five scenarios: 8 fewer at monsoon-surge, 1 at
capability-scarcity, 1 at ambiguous-diagnosis, 1 at technician-dropout. Every
mean in the table is taken over jobs that finished, so **a policy that strands
more of the board posts a flattering mean**. Read `resolved` before you read
anything else. At monsoon-surge the honest summary is: global resolved 90 of
180 jobs in a mean of 126.6 minutes; skill-aware resolved 98 in 192.7. Whether
that is a win depends on what you are optimising, and the harness deliberately
refuses to decide for you.

**Why it loses.** The harness measured the cause rather than guessing at it:
zone partitioning. Above 400 candidate options the solver splits the board by
zone instead of solving one citywide matrix, because the Hungarian algorithm is
O(n³). Running one scenario twice with nothing changed but that threshold:

| scenario | partitioned | whole-fleet matrix |
| --- | ---: | ---: |
| monsoon-surge | 58/180 resolved, 51.8 min | 69/180 resolved, 53.7 min |
| ambiguous-diagnosis | 18/60 resolved, 51.9 min | 24/60 resolved, 59.0 min |

Partitioning buys a better mean and pays for it in jobs served. A job sits in a
zone whose own units are busy while a neighbouring zone has capacity, and the
partitioned matrix cannot see across.

**What these numbers are not.** Travel time in the harness is a haversine
estimate with a road factor, not an OSRM route, so absolute minutes are
optimistic — every policy sees the same estimates, so the comparison holds and
the absolute service level does not. The simulated true fault is drawn from the
same distribution the solver sees, so the diagnosis is perfectly calibrated by
construction; a real intake is not, and that flatters the belief-driven
policies more than nearest-unit. `EVALUATION.md` carries the full list.

### The AI intake, measured the same way

`npm run eval:ai` runs 108 hand-labelled breakdown descriptions in English,
romanised Hindi and a mixture of the two through the real intake path, against
a keyword control — 72 lines of substring tables:

| extractor | top-1 | top-2 | ECE | schema valid | fallback | entropy↔2nd-dispatch r |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| keyword-baseline | 59.3% | 76.9% | 0.136 | 100.0% | 0.0% | 0.425 |
| llm (`gpt-oss-120b`) | **68.5%** | **79.6%** | 0.152 | 99.1% | 0.0% | 0.156 |

The model is worth 9.2 points of top-1 accuracy over that substring table, and it
made the pipeline slightly *worse* calibrated. The last column is the one that
changed a decision: the cost function hedges on uncertainty, and that hedging
is only justified if uncertainty predicts a wasted visit. At r = 0.156 it does
not, on this set, with this extractor — so the report prints "treat the
entropy-driven hedging as unproven rather than validated". The labels are
hand-written by the author of the prompt; read the accuracy as "can the
pipeline recover a fault from a description containing it", not as field
accuracy.

---

## Reproducing this

Everything below runs locally. Nothing calls a hosted API — the router is
self-hosted OSRM, and the LLM is optional (with no key, intake falls back to a
structured symptom picker and the system stays fully functional).

```bash
cp .env.example .env          # fill in two JWT secrets; the LLM key is optional
docker compose up -d          # postgres 16, redis 7, osrm
./scripts/setup-osrm.sh       # ONCE: downloads and preprocesses the Bengaluru map
npm install
npm run db:migrate            # 11 migrations
npm run db:seed               # 6 zones, 24 units, 31 technicians, uneven capabilities

npm run eval                  # the table above, into EVALUATION.md
npm run eval:ai               # the AI table above, into EVALUATION_AI.md
npm test                      # 643 fast tests, then 9 concurrency tests against
                              # a Postgres 16 container the suite starts itself
```

Then `npm run dev` and `npm run dev:worker`, and open `/dispatcher.html`,
`/driver.html` or `/technician.html`. Every seeded account shares one password,
defined once in `prisma/seed/devPassword.ts` — which is why that file exists
rather than the string being scattered through four seeders.

The eval needs no running server — it is a pure replay through the engine.

---

## What is in here

**The engine** is a pure function over a snapshot and writes nothing: candidate
generation, ten hard-constraint filters that return reason codes (never
penalties), a five-term cost function summing over the fault distribution, a
lexicographic safety ordering *above* the cost function, and a Hungarian
assignment implemented by hand and verified against brute force on 300 seeded
matrices.

**The commit path** is a three-leg saga — hold a unit, offer it to a
technician, offer the destination — with compensations in reverse order and
crash recovery at worker startup. Unit holds are version-checked conditional
updates; 50 concurrent attempts on 10 units grant exactly 10, proved against a
real Postgres the test suite starts.

**Intake** turns symptoms into a probability distribution with a hand-written
naive-Bayes table, then asks the question with the highest expected information
gain until one of four stop conditions fires — including "every contending
fault now needs the same crew", which is what makes it a dispatch system rather
than a diagnosis quiz. From Phase 16 an LLM can fill that form in from free
text, and the driver confirms it before anything dispatches.

**Degradation is designed, not incidental.** Six components on a ladder, three
modes, re-probed every fifteen seconds. DEGRADED means something is doing a
simpler job — the picker instead of the model, polling instead of pushes, the
best plan found instead of the best plan there is. CRITICAL means the system is
no longer deciding and a person is, through a defined manual workflow with the
queue on screen and every write audited. Eight chaos controls force each state
on demand and are absent from a production build. See `CHAOS_TESTING.md`.

**Money** is integers in paise, double-entry, with a balance assertion that
runs after every money test.

## Deliberately not built

- **Multi-stop routing.** One active job per unit. Multi-stop turns assignment
  into a vehicle-routing problem, and the honest version of that is a different
  project.
- **Cross-van part transfer.** Modelled as impossible on purpose: it makes
  stock a network flow rather than a per-unit count.
- **Coverage as a forecast optimiser.** Positioning crews against predicted
  demand needs demand history this project does not have; inventing one would
  make every number downstream a fiction.
- **A fairness term in the cost function.** Earnings Gini is measured and never
  optimised, so the table shows what optimising purely for resolution time does
  to the spread of work.

## Where to look

| | |
| --- | --- |
| `docs/CODEMAP.md` | where things live, a reading order, three call paths |
| `EVALUATION.md` | the full harness output, its findings and its limits |
| `EVALUATION_AI.md` | the AI intake evaluation, per-language and per-bin |
| `CHAOS_TESTING.md` | every chaos control and what was observed when it was pulled |
| `INTERVIEW.md` | design decisions, concurrency arguments, and §15 — what an interviewer can attack |
| `CLAUDE.md` | the invariants this codebase is not allowed to break |
