# Deployment

This is the target shape. Nothing here is built yet — deployment work lands
in Phase 26. It is written down now so the choices made along the way stay
compatible with it.

## Shape

- ONE platform. ONE origin. TWO always-on processes: `web` and `worker`.
- Managed Postgres and managed Redis from the same provider.
- Migrations run on release (`npm run db:deploy`).
- The seed is idempotent and safe to run on every release.

## No free tier that sleeps

The simulator, the queues and the WebSocket connections must stay up. A
platform that spins the process down after idle produces an empty dispatch
board, which is the one thing an interviewer must never open the link to.
Budget for a paid always-on tier (~$10–20/month).

## No separate frontend host

A split frontend does not fix a cold start — the cold start lives in the API
and the WebSocket handshake, not in serving the HTML. And a serverless
frontend host cannot hold the persistent WebSocket connections the dispatch
board depends on. Express serves `/public` from the same origin.

## Keeping the deployed board alive

- The simulator (Phase 3) runs continuously on the deployed instance so the
  board is never empty.
- A scheduled reset every 4 hours, announced in the UI before it happens.
- Four demo accounts seeded, with the dispatcher console featured.

## LLM cost ceiling (from Phase 16)

- A per-IP rate limit on intake.
- A global daily token budget. Crossing it trips DEGRADED mode, which falls
  back to the deterministic intake path. The resilience fallback and the cost
  ceiling are the same mechanism.

## The rule everything serves

An interviewer opening the link cold sees something interesting within thirty
seconds, without clicking anything.
