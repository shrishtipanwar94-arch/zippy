# Turning the demo board on — Railway, in order

Switches the deployed site to the six-act demo (DEMO.md) **without deleting
anything**: the full seed stays in the database and demo mode hides it by
filter. Undo is one variable.

Every step says what it changes and who does it. Steps marked **YOU** touch
secrets or money, so they are yours; the rest the assistant can run on request.
All commands run from the repository root with the Railway CLI logged in and
linked to the `zippy` project.

---

## 1 — Turn Razorpay off · **YOU**

```bash
for s in web worker; do
  for k in RAZORPAY_KEY_ID RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET RAZORPAY_PAYOUT_ACCOUNT_NUMBER; do
    railway variable delete "$k" -s "$s"
  done
done
```

**Changes:** payments switch to the stub provider — the demo's "manual path",
which authorises at accept and captures at completion with no gateway. Daily
payouts stay PENDING instead of going to RazorpayX test. Each delete redeploys
the service it touches; that is fine.

**Why first:** with Razorpay on, the reference job the seed creates in step 3
would open a Razorpay test order nobody pays, leaving an authorisation pending
for good — and the payments banner amber within ten minutes. Your keys stay in
your local `.env`; nothing is lost.

## 2 — Confirm the demo password · **YOU**

```bash
railway variable list -s web --kv | grep -c '^SEED_PASSWORD='    # must print 1
```

**Changes:** nothing. The boot-time seed sets the three demo logins' password
from `SEED_PASSWORD` and refuses to run without it. To choose a new one:

```bash
read -rs -p 'new SEED_PASSWORD: ' P && echo
printf '%s' "$P" | railway variable set SEED_PASSWORD --stdin -s web --skip-deploys
unset P
```

(The worker does not need it.)

## 3 — Deploy the code · assistant or you

```bash
git push origin master
```

**Changes:** both services rebuild from `master` (push-to-deploy triggers exist
on web and worker). With `DEMO_MODE` still off, the only behaviour that changes
on the live site is the assistant's spending ceiling (production only, below).

## 4 — Turn demo mode on · assistant or you

```bash
railway variable set DEMO_MODE=true -s web    --skip-deploys
railway variable set DEMO_MODE=true -s worker --skip-deploys
railway deployment redeploy -s web -y
#   wait for SUCCESS:  railway deployment list -s web
railway deployment redeploy -s worker -y
```

**What the web boot does** (after `prisma migrate deploy`, before serving):
`ensureDemoBoard` creates or refreshes the demo zone, the four crews (only B
can sign in), the demo workshop, the demo driver, the hidden reference driver,
and — once — the reference job, run through the real dispatch path. Upserts on
natural keys; nothing is deleted. Its log ends with
`demo board ready: ... reference job: created, RESOLVED`. If the seed fails the
deploy fails, rather than serving an empty board.

**What demo mode changes while it is on:** the solver and every dispatcher list
see only the demo board (the 24 seeded vans, 3 depots and 12 workshops are
hidden by filter); the sign-in pages offer only the three demo accounts; a
reported job gets a dispatch card as soon as intake finishes; a declined or
timed-out offer is re-planned without the crew that refused.

**What the worker does:** on boot and every 15 minutes it frees a stuck demo
van, retires demo jobs left unassigned for over an hour, re-opens the crews'
shifts and re-counts their stock. A van on a running job is never touched.

No one-time command is needed: the seed runs on every web boot.

## 5 — Check it · assistant or you

```bash
railway ssh -s web -- npx tsx scripts/demo-dry-check.ts     # must end: PASS ... end to end
curl -s https://web-production-bd67f3.up.railway.app/login/accounts   # three accounts
curl -s https://web-production-bd67f3.up.railway.app/health           # status ok, routing HAVERSINE
```

**Changes:** the dry check files 11 real jobs through the driver's routes and
retires each one (CANCELLED, never deleted). `railway ssh` needs an SSH key
registered once per machine: `ssh-keygen -t ed25519`, then
`railway ssh keys add`.

---

## The assistant (AI) — what turns it on

| variable | service | |
| --- | --- | --- |
| `LLM_API_KEY` | **web** | the key; unset means no assistant (the picker still works) |
| `LLM_PROVIDER` | web | `openai-compatible` for Groq |
| `LLM_MODEL` | web | e.g. `openai/gpt-oss-120b` |
| `LLM_BASE_URL` | web | Groq's endpoint is the default |
| `AI_HOURLY_LIMIT_PER_IP`, `AI_DAILY_CALL_CAP` | web | optional; defaults 20 and 300 |

Only **web** calls the model (the describe box and chat classification run in
its routes). They are currently set on the worker too, which is harmless. The
ceiling applies in production only; past it the driver is told in one sentence
and continues with the question picker.

## Turning it off again

```bash
railway variable delete DEMO_MODE -s web
railway variable delete DEMO_MODE -s worker
```

**Changes:** every filter switches off and the full seed is back in view; the
worker removes its demo schedule on boot. The demo rows stay in the database —
and crew B, which can do everything, would then compete for the main seed's
jobs, so take it off the board if you leave demo mode for long: set the four
units whose code starts `DMO-V` to `OFFLINE` (one SQL `UPDATE`; reversible by
setting them back to `AVAILABLE`, or by turning demo mode on again, whose seed
does that itself).

---

## Appendix — Postgres 16 and Redis 7 (optional, NOT tested)

The live services came up on Railway's template defaults, **Postgres 18** and
**Redis 8.2**; the stack, `docker-compose.yml` and the test suites are on
**16** and **7**. Nothing has failed because of it, but it is a gap between
what is tested and what runs. A major version cannot be changed in place — a
data directory written by 18 will not start under 16 — so the change is a new
service, which **replaces the database**, and so it is ruled out while the rule
is "no wipe". If that rule is ever lifted: delete the service and its volume,
add a new one from the template named exactly `Postgres` (so
`${{Postgres.DATABASE_URL}}` resolves to it) with its image set to
`ghcr.io/railwayapp-templates/postgres-ssl:16` before it first starts, the same
for `Redis` with `redis:7`, then redeploy web (migrations run on boot) and
worker. Unrehearsed.
