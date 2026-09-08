#!/usr/bin/env bash
#
# THE DEMO PREP, AS A SCRIPT RATHER THAN A BLOCK YOU PASTE.
#
# WALKTHROUGH.md used to carry this as six lines to copy into a terminal, and
# the ordering mattered but nothing enforced it. `npm run db:reset` is the
# first step and every step after it assumes it worked; when the reset was
# refused, the rest ran anyway and built a board out of yesterday's jobs and
# today's. That board looks right — jobs, units, shifts, an action queue — so
# nothing on screen tells you to distrust it.
#
# It is a FILE and not a pasted block because `set -e` cannot be relied on in a
# shell you pasted into. Two ways it silently does nothing:
#
#   1. errexit exempts a command on the left of `&&` or `||`. So both
#      `npm run db:reset && npm run db:seed` and
#      `( set -e; ...steps... ) || echo failed` swallow the refusal and carry
#      on — the second one especially, because it looks like the fix.
#   2. under `bash -c`, errexit can be set (`$-` contains `e`) and still not
#      stop a failing command. Verified on this machine.
#
# In a script run as a file, `set -e` behaves. That is the whole reason this
# file exists.

set -euo pipefail

trap 'echo; echo "PREP FAILED at line $LINENO. STOP."; echo "The board is half-built: some steps ran, the one above did not."; echo "Fix the error, then run this script again from the top. Do not demo this board."; exit 1' ERR

# PRISMA WILL REFUSE THIS STEP FOR AN AI AGENT.
#
# Prisma Migrate detects that it was invoked by an agent and blocks
# `migrate reset --force` outright, printing a consent notice and exiting
# non-zero. Run this script yourself and it resets normally. An agent that has
# your explicit consent re-runs it with PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION
# set to the exact text of the message in which you gave that consent.
echo "== db:reset (drops and reseeds; Prisma refuses this for an AI agent)"
npm run db:reset

echo "== flush Redis (stale BullMQ queues from the last run)"
docker exec zippy-redis-1 redis-cli FLUSHALL

echo "== fleet history"
npx tsx scripts/demo-prep-beat9.ts

# AFTER THE SEED, BEFORE ANYTHING IS DISPATCHED. Without this every technician
# is off shift, NO_TECHNICIAN_ON_SHIFT filters out all 24 units, and the board
# fills with jobs nothing can be sent to.
echo "== open every shift (REQUIRED)"
npx tsx scripts/demo-open-shifts.ts

# Without this `acceptance_outcomes` is empty, every workshop sits on the same
# cold-start prior, and destinationRefusalRisk ranks nothing. The outcomes are
# fabricated — no workshop has ever answered anything in this system.
echo "== workshop acceptance history"
node scripts/simulate-200-offers.js --workshop A --decline-evenings

# The --start is what dates the jobs into the last half hour. Without it the
# simulator dates them 2026-06-01, every SLA window has already closed, and the
# action queue opens with twenty escalations you have to scroll past.
echo "== raise the board"
npx tsx src/sim/cli.ts \
  --rate 45 --duration 28 --max-jobs 22 --seed 11 \
  --start "$(node -e "console.log(new Date(Date.now()-30*60000).toISOString())")"

echo
echo "PREP OK. Now start the two processes in their own windows:"
echo "  npm run dev          # http://localhost:3000"
echo "  npm run dev:worker"
echo
echo "Then check the board before Step 1 — see WALKTHROUGH.md 0b. The"
echo "safety-level split is drawn fresh each run and is not a fixed number."
