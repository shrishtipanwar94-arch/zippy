# Chaos testing

Every control in the dispatcher console's **Chaos controls** panel, what it
actually does, and what was observed when it was pulled. Written from a real
walkthrough against a seeded database, not from intent — where a control did
something less interesting than it sounds, this says so.

The panel exists only in a dev or demo build: `mountChaosRoutes` registers
nothing when `NODE_ENV=production`, so the routes are absent rather than
forbidden (`src/api/chaos.ts`). In a dev build they still require a
DISPATCHER's `chaosControl` permission.

## The ladder

`src/domain/healthLadder.ts` is the table. Six components, three modes:

| Mode | Meaning |
| --- | --- |
| NORMAL | Everything is doing its own job. |
| DEGRADED | Something is doing a **simpler** job instead. Dispatch decisions are still made by the system and are still correct — they are made with less information, or delivered by a worse channel. |
| CRITICAL | The system is no longer deciding. A person is, through a defined manual workflow, and every write is still audited. |

| Component | Degraded behaviour | Worst it can cause |
| --- | --- | --- |
| Symptom assistant | Drivers answer the structured symptom picker. | DEGRADED |
| Vehicle positions | Last known position, flagged; a dispatcher can confirm a corrected one from the driver's chat. | DEGRADED |
| Live updates | Consoles poll every five seconds. | DEGRADED |
| Planner | Best plan found before the deadline, flagged as incomplete. | DEGRADED |
| Payments | Authorisations pending and retried; dispatch never blocked. | DEGRADED |
| Automatic dispatch | Priority queue stays visible, writes still audited; new assignments resume on recovery. | **CRITICAL** |

A component can never push the system past its own worst case. A probe that
reported the symptom assistant as CRITICAL still leaves the system DEGRADED —
`systemMode` clamps it, because an operator who learns to ignore a red banner
is a worse outcome than any single component being down.

The health-check loop (`src/health/loop.ts`) re-probes every **15 seconds** in
the worker process, writes `system_health_states`, and logs every transition.
It is a bare timer rather than a queued job on purpose: the queue runs on
Redis, and Redis being down is one of the states the loop exists to report.

## Switches — these stay on until switched back

### Toggle LLM (`LLM_DOWN`)

**What happens.** `POST /jobs/intake/describe` returns `200` with
`degraded: true`, the driver's page shows the amber banner *"Our assistant is
unavailable right now, so we will ask you a few questions instead"*, and the
structured symptom picker appears. Every failed attempt is still written to
`ai_extractions`, so the fallback rate stays measurable.

**Observed.** `AI_EXTRACTION: DEGRADED`, system `DEGRADED`; automatic dispatch
untouched. Switched back: `NORMAL` on the next probe.

**What it does not do.** It does not stop a job being created, dispatched or
resolved. The whole point of the AI sitting at the edge is that this control is
boring for everyone except the person typing.

### Toggle Redis (`REDIS_DOWN`)

**What happens.** The solver queue is unreachable, so nothing re-plans
automatically. `DISPATCH_CORE` goes **CRITICAL** and the console's banner turns
red: *"Automatic dispatch is down (Automatic dispatch, Live updates). The
priority queue stays visible and every write is still audited. New assignments
resume automatically when dispatch recovers."* Live updates go with it — the Socket.IO fan-out uses the same Redis — so consoles
fall back to polling at the same moment.

**Observed.** `DISPATCH_CORE: CRITICAL`, `WEBSOCKET: DEGRADED`, system
`CRITICAL`. Switched back: both `NORMAL` on the next probe.

**This is the one control that reaches CRITICAL**, and it is the one worth
demonstrating slowly: the queue is still on screen, the jobs are still there,
and a dispatcher can still act. CRITICAL is a mode, not a crash.

### Toggle WebSocket (`WEBSOCKET_DOWN`)

**What happens.** The socket handshake is refused before authentication and
every connected socket is dropped (`suppressLiveUpdates`). The browser's own
reconnect loop keeps failing, `connect_error` fires, and `public/js/socket.js`
starts polling every five seconds instead. The console keeps working; it finds
out later.

**Observed.** `WEBSOCKET: DEGRADED`, system `DEGRADED`. Switched back, the next
reconnect attempt succeeds and polling stops on its own.

**Why refuse the handshake rather than drop messages.** A client that believes
it is connected and is silently missing events is a worse failure than the one
being demonstrated, and an invisible one.

### Force solver timeout (`SOLVER_TIMEOUT`)

**What happens.** The planner's deadline drops from 20 seconds to 200
milliseconds on both paths — the queued re-plan and the dispatcher's Solve
button. Jobs already scored are planned normally; jobs the planner never
reached keep whatever assignment they already had, and the run is stored with
`solver_runs.timed_out = true`.

**Observed**, on a board of 470 pending jobs:

| | options generated | wall clock |
| --- | ---: | ---: |
| switch on | 96 | 1,884 ms |
| switch off | 11,280 | 11,011 ms |

`SOLVER: DEGRADED` with *"the last plan hit its deadline; unreached jobs kept
their assignment"*. Switched back, the component returned to NORMAL on its own
once the next full run was stored — no flag was cleared by hand.

## Actions — these happen once

### Take a technician offline (`TECHNICIAN_OFFLINE`)

Ends every current shift for one technician through the ordinary shift write
and fires a re-plan for their zone. Their unit is left with nobody in it, which
is exactly what the feasibility engine's `NO_TECHNICIAN_ON_SHIFT` code exists
for — this is the fastest way to produce an escalation card with a real reason
on it.

**Observed:** `technician tech-24 is off shift`.

### Break a unit (`BREAK_UNIT`)

Moves a unit to `MAINTENANCE` with a conditional update on the version it read,
writes a `unit_status_history` row, and re-plans the zone. A chaos control that
clobbered a concurrent dispatch would be demonstrating a bug rather than a
failure mode.

**Observed:** `unit unit-24 is in MAINTENANCE`.

### Force a destination decline (`DECLINE_DESTINATION`)

Marks the newest proposed destination offer `DECLINED` and appends a
`DESTINATION_DECLINED` job event, so the refusal appears on the job's own
timeline rather than in a side channel.

**Observed on a database with no proposed offers:** `no destination offer to
decline`. That is the honest answer and the control does nothing — it needs a
job that has reached the tow path first.

### Inject N jobs (`INJECT_JOBS`)

Creates N breakdowns through **real intake** — the same transaction, the same
rule table, the same events. Coordinates are scattered slightly so they do not
all snap to one node of the routing graph, which would make every travel time
identical and the load test meaningless. Capped at 50.

**Observed:** `3 jobs injected`, queue depth up by three, planner wall clock up
accordingly.

### Reset everything (`POST /chaos/reset`)

Turns every switch off and re-probes immediately. **The most important button
on the panel**: a demo that leaves the system in a state it cannot be talked
out of is the worst possible outcome, so there is always one control that puts
everything back.

## The escalation card

When no plan exists, `UNSERVICEABLE` is a handover, not an end state. The
dispatcher's inspector shows the card instead of a blank panel. Observed on a
real job whose every option was refused:

```
reason code   CAPABILITY_MISSING
reason        No available crew holds every skill this fault needs.
closest       UNIT-07 (Technician 07) is 2 min away but was rejected:
              technician is off shift, or their shift ends before the job
              could complete.
alternative   A specialist partner, or a tow to a workshop that has the skill.
recommendation Consider a tow to a workshop instead of a roadside repair, or
              approve a partner callout.
actions       Approve anyway · Find external provider · Contact driver
```

Note what "closest" means: **the nearest option a human could actually clear**,
not the nearest van. A unit fifty metres away that physically cannot climb the
ramp is not close to being an answer; one twenty minutes away waiting on a
technician to come on shift is. The ranking is in
`src/domain/escalationCard.ts`.

Every decision is written to `escalations` / `escalation_decisions` with the
role and user who made it. `CONTACT_DRIVER` leaves the escalation open — the
dispatcher is coming back with what the driver said; the other two resolve it.

## What is deliberately not here

- **No control breaks Postgres.** It is the source of truth for every hold and
  reservation, and a switch that corrupted it would demonstrate nothing except
  that the demo can lose data.
- **No control forges a dispatch.** Every action goes through the same writes
  the real path uses; a control that took a shortcut would be demonstrating the
  shortcut.
- **GPS staleness has no switch.** It is derived from `units.last_location_at`,
  so the way to demonstrate it is to stop the simulator — which is what a real
  telemetry outage looks like. On a database whose fleet has not moved
  recently, `Vehicle positions: DEGRADED` is the standing, truthful reading.
