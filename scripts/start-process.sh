#!/bin/sh
# WHICH PROCESS THIS CONTAINER IS. The app image (Dockerfile) is shared by the
# web and worker services; each sets ZIPPY_PROCESS so one image starts as
# either. `exec` hands the PID to node, so the platform's stop signal reaches
# the process that has to drain connections and close queues.

set -e

case "${ZIPPY_PROCESS:-web}" in
  web)
    # MIGRATIONS RUN HERE, ON RELEASE, and only here. Two services racing to
    # apply the same migration is a problem Prisma's advisory lock survives,
    # but running it from exactly one place means nobody has to know that.
    npx prisma migrate deploy
    exec node dist/index.js
    ;;
  worker)
    exec node dist/worker.js
    ;;
  *)
    echo "ZIPPY_PROCESS must be 'web' or 'worker', got '$ZIPPY_PROCESS'" >&2
    exit 1
    ;;
esac
