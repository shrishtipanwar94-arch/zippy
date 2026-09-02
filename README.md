# Zippy

Roadside breakdown dispatch, optimised for **time-to-resolution** rather than
time-to-arrival.

The nearest technician often cannot fix the fault. Sending them is fast to
arrive and slow to resolve, because a second dispatch then has to happen. Zippy
plans against the probability distribution over what is actually wrong, sends a
crew who can cover the likely faults, and prices the risk of a wasted visit
directly into the objective function.

That claim is measured rather than asserted, and the measurement is in this
repository. Every number below comes from `npm run eval` (and `npm run
eval:sweep` for the robustness grid), which replays seeded scenarios through
the production engine — the same `candidates.ts`,
`feasibility.ts`, `cost.ts` and `allocation.ts` the server uses. There is no
second implementation of the solver for benchmarking.

---

## The benchmark

Seed `20260901`, six scenarios, four policies. Two runs of the same seed
produce byte-identical output (the "solver wall clock p95" block the harness
prints last is explicitly excluded — it is timing, not a decision); this table
was pasted from the second run.

| scenario | policy | resolved | stranded | 1st-visit | mean arrival | **mean resolution** | 2nd dispatch | SLA breach | stockout fails | utilisation | earnings Gini |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| normal-day | fifo | 42/60 | 0 | 65.0% | 35.9 min | 59.9 min | 33.3% | 9 | 70 | 20.9% | 0.623 |
| normal-day | nearest-unit | 41/60 | 0 | 63.3% | 37.3 min | 63.4 min | 30.0% | 14 | 97 | 20.2% | 0.612 |
| normal-day | skill-aware | 40/60 | 0 | 61.7% | 38.1 min | 70.4 min | 33.3% | 14 | 105 | 21.6% | 0.600 |
| normal-day | capability-aware-global | 56/60 | 1 | 94.9% | 53.1 min | 78.3 min | 5.1% | 19 | 10 | 15.7% | 0.648 |
| monsoon-surge | fifo | 39/180 | 59 | 32.2% | 164.5 min | 202.3 min | 29.8% | 128 | 127 | 32.1% | 0.451 |
| monsoon-surge | nearest-unit | 37/180 | 61 | 31.1% | 163.2 min | 208.1 min | 29.4% | 132 | 136 | 32.3% | 0.453 |
| monsoon-surge | skill-aware | 36/180 | 62 | 30.5% | 143.2 min | 189.8 min | 36.4% | 125 | 149 | 32.2% | 0.456 |
| monsoon-surge | capability-aware-global | 76/180 | 99 | 93.8% | 102.1 min | 131.1 min | 3.7% | 133 | 0 | 21.0% | 0.537 |
| capability-scarcity | fifo | 19/23 | 0 | 60.9% | 35.9 min | 73.2 min | 39.1% | 3 | 50 | 11.7% | 0.710 |
| capability-scarcity | nearest-unit | 18/23 | 0 | 69.6% | 29.4 min | 82.4 min | 30.4% | 4 | 124 | 9.8% | 0.615 |
| capability-scarcity | skill-aware | 19/23 | 0 | 73.9% | 30.4 min | 85.3 min | 26.1% | 4 | 122 | 8.9% | 0.639 |
| capability-scarcity | capability-aware-global | 22/23 | 0 | 95.7% | 45.1 min | 72.0 min | 4.3% | 6 | 0 | 6.7% | 0.734 |
| ambiguous-diagnosis | fifo | 22/60 | 29 | 71.0% | 152.7 min | 173.6 min | 3.2% | 52 | 14 | 8.7% | 0.848 |
| ambiguous-diagnosis | nearest-unit | 22/60 | 28 | 68.8% | 146.8 min | 156.1 min | 3.1% | 52 | 15 | 8.7% | 0.848 |
| ambiguous-diagnosis | skill-aware | 22/60 | 28 | 68.8% | 146.8 min | 156.1 min | 3.1% | 52 | 15 | 8.7% | 0.848 |
| ambiguous-diagnosis | capability-aware-global | 19/60 | 39 | 90.5% | 81.7 min | 114.6 min | 9.5% | 49 | 5 | 5.7% | 0.885 |
| technician-dropout | fifo | 39/60 | 0 | 61.7% | 63.3 min | 82.6 min | 30.0% | 27 | 59 | 18.4% | 0.635 |
| technician-dropout | nearest-unit | 41/60 | 0 | 63.3% | 50.3 min | 82.1 min | 31.7% | 19 | 74 | 17.7% | 0.654 |
| technician-dropout | skill-aware | 39/60 | 0 | 60.0% | 54.2 min | 84.5 min | 31.7% | 23 | 81 | 18.6% | 0.645 |
| technician-dropout | capability-aware-global | 54/60 | 3 | 94.7% | 62.4 min | 87.3 min | 5.3% | 19 | 5 | 14.3% | 0.691 |
| parts-stockout | fifo | 21/60 | 5 | 32.7% | 93.0 min | 117.5 min | 20.0% | 45 | 54 | 15.4% | 0.740 |
| parts-stockout | nearest-unit | 22/60 | 2 | 36.2% | 92.2 min | 114.7 min | 15.5% | 44 | 52 | 15.3% | 0.743 |
| parts-stockout | skill-aware | 22/60 | 2 | 36.2% | 92.2 min | 114.7 min | 15.5% | 44 | 52 | 15.3% | 0.743 |
| parts-stockout | capability-aware-global | 27/60 | 30 | 90.0% | 84.6 min | 119.5 min | 10.0% | 45 | 27 | 12.9% | 0.759 |

### How to read it, including where it loses

**The headline.** `capability-aware-global` **resolves more jobs than any
baseline in five of the six scenarios**, counted over every job in the scenario
— +14 at normal-day (56/60 against 42), roughly twice as many at monsoon-surge
(76/180 against 36–39), +13 at technician-dropout. That denominator is the whole
board, so the number cannot be flattered by declining hard work. The mechanism
is first-visit resolution — global sends a crew who can close the fault on the
first attempt 90–96% of the time against 30–74% for the greedy policies, though
that rate is taken only over the jobs it actually dispatched to, which excludes
exactly the ones it strands (the `stranded` column, shown alongside and largest
on the same scenarios). Second dispatches track it: 4–5% against 26–39% on
normal-day, monsoon-surge, capability-scarcity and technician-dropout. On parts
it barely strands work for want of a component — `stockout fails` is 0 at
monsoon-surge and capability-scarcity and no higher than 27 in any scenario,
where the greedy policies run 50 to 149 everywhere except ambiguous-diagnosis.

**Where it costs more, and why.** On the three scenarios where the fleet has
slack — normal-day, technician-dropout, parts-stockout — global posts a *slower*
mean time-to-resolution, by roughly 5 to 18 minutes against whichever baseline
is fastest in that scenario (so the gap is not 2 minutes against fifo alone at
parts-stockout — it is 4.8 against nearest-unit, which is faster there). Every
mean in the table is taken over jobs that **finished**, and global finishes the
slow, hard ones the greedy policies leave unresolved — so those long jobs land
in global's average and never enter fifo's at all. Read `resolved` first: at
normal-day, fifo's 59.9-minute mean is an average over the 42 easiest jobs of
60; global's 78.3 is over 56.

**Where it wins the mean too.** Under real pressure the effect reverses.
Monsoon-surge: 131.1 minutes against 190–208, resolving roughly twice as many
jobs. Capability-scarcity: 72.0 against 73–85, and 22/23 resolved against 18–19.

**Where it loses outright.** Ambiguous-diagnosis, scored on jobs served: 19/60
against nearest-unit's 22/60. Global's mean there is 42 minutes faster and its
first-visit rate 22 points higher, but it strands more (39 against 28) and the
harness scores that scenario on throughput, so it hands the scenario to
nearest-unit and says so in `EVALUATION.md`. `npm run eval:sweep` re-runs the
whole grid under six perturbations and tests one narrow claim — global resolves
at least as many jobs as every baseline, and none beats it on mean while
resolving as many. It **holds** at volume ×3, half the technicians and half the
units; it **fails** at the baseline and OBD-scarce grids (ambiguous-diagnosis
again) and at volume ×2, where mid-range load lets the greedy policies catch up
on throughput while global's stranding climbs. The weak point is consistent:
ambiguous-diagnosis, the scenario with the least diagnostic signal to act on.

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
npm test                      # 800 fast tests, then 9 concurrency tests against
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
