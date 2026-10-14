#!/usr/bin/env bash
#
# RESET TO THE MINIMAL DEMO BOARD — one zone, one crew, one van.
#
# This is the demo equivalent of scripts/demo-prep.sh, and it is much shorter
# for one reason: the minimal seed computes its own shift window relative to
# NOW, so there is no "open every shift" step to forget, and no workshop or
# acceptance history to fabricate. Run it, start the two processes, demo.
#
# IT IS A FILE AND NOT A PASTED BLOCK for the reason demo-prep.sh documents at
# length: `set -e` cannot be relied on in a shell you pasted into, and the
# first step here is destructive. The ordering matters and nothing but a real
# script enforces it.
#
# WHAT IT DESTROYS: everything. The reset drops the database and replays every
# migration, so the main seed's board, every job, every event and every payment
# goes with it. That is the point — a demo opening on twenty-five pending jobs
# is not a demo — but it is also why this is a script nobody should run by
# accident. The main seed itself is untouched on disk; `npm run db:reset`
# rebuilds the full 24-unit board whenever you want it back.

set -euo pipefail

trap 'echo; echo "RESET FAILED at line $LINENO. STOP."; echo "The database is half-built: some steps ran, the one above did not."; echo "Fix the error and run this script again from the top. Do not demo this board."; exit 1' ERR

# --skip-seed IS THE WHOLE TRICK, and it is why this script needs no step that
# deletes the main seed's fleet afterwards.
#
# `prisma migrate reset` runs the seed configured in package.json
# (prisma/seed.ts) as its final step, which would build the full 24-unit board
# — and then a minimal demo would mean deleting 24 units, 31 technicians and
# their capability links back out again, which is a destructive query written
# against rows somebody else's tests depend on. Skipping the seed instead
# leaves an empty, migrated database, and the minimal seed below fills in both
# the lookup tables and its own small fleet.
#
# NOTE: this is `npx prisma` rather than `npm run db:reset` precisely so the
# flag can be added here without changing the shared script.
#
# PRISMA WILL REFUSE THIS STEP FOR AN AI AGENT. Prisma Migrate detects that it
# was invoked by an agent and blocks `migrate reset --force` outright, printing
# a consent notice and exiting non-zero. Run this script yourself and it resets
# normally.
echo "== reset the database, WITHOUT the main seed (drops everything)"
npx prisma migrate reset --force --skip-seed

echo "== seed the minimal demo board"
npm run db:seed:demo

echo "== flush Redis (stale BullMQ queues from the last run)"
docker exec zippy-redis-1 redis-cli FLUSHALL

# THE CHECK THAT MATTERS. A board can look right on every screen and still
# refuse to dispatch, because the capability requirement is computed from a
# probability distribution rather than from a fault code. This runs the real
# classifier, candidate generator and feasibility filter and exits non-zero if
# nothing is feasible — so a broken board fails here rather than in front of an
# audience.
echo "== dry check: is the board actually dispatchable?"
npx tsx scripts/demo-dry-check.ts

echo
echo "RESET OK. Now start the two processes in their own windows:"
echo "  npm run dev          # http://localhost:3000"
echo "  npm run dev:worker"
echo
echo "Then follow DEMO.md from Step 1."
