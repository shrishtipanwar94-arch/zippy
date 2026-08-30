#!/usr/bin/env bash
# ONE-TIME OSRM SETUP — run this once (and again only if the map data should
# be refreshed), not on every `docker compose up`.
#
# Downloads an OpenStreetMap extract covering Bengaluru — the city every
# seeded zone (prisma/seed/zones.ts) is in — and runs OSRM's three
# preprocessing steps into ./osrm/data, which docker-compose.yml's `osrm`
# service then serves. This is a genuinely separate step from starting the
# container: OSRM does not download or build its own map data, and building
# it takes real time and disk, which is exactly why it happens once, by hand,
# rather than inside `docker compose up`.
#
# WHY BENGALURU: the seed already picked it (six zones, Phase 1). Nothing
# here decides the city; it just builds the map the seed already committed to.
#
# WHY THE OVERPASS API, NOT A GEOFABRIK COUNTRY/STATE EXTRACT: Geofabrik does
# not offer a Karnataka-sized cut for India, only the whole country — several
# hundred MB and a much longer preprocessing run for a project that only ever
# dispatches inside one city. Overpass's own `/api/map` endpoint exports a
# bounding box directly, which is a closer match to "one city" than "one
# country." The box below is generous around the seeded zone centroids
# (roughly Electronic City in the south to Hebbal in the north, Jayanagar in
# the west to Whitefield in the east) so real jobs and units placed with the
# simulator's jitter still land inside it.
#
# THIS WILL TAKE A WHILE. The Overpass export alone can run several hundred
# MB for a metro area as densely mapped as Bengaluru (buildings and points of
# interest dominate the file, not roads), and extract/partition/customise
# read that whole file more than once. Do not run this as part of a tight
# feedback loop — run it once, then leave osrm/data alone.
#
# Requires Docker, and network access to Overpass. If Overpass is
# unreachable or rate-limited, the script exits with an error rather than
# silently producing a truncated map that would preprocess into a broken
# graph — a corrupt city-shaped hole in the road network is a much worse
# failure than "the script didn't run."

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/osrm/data"
OSM_FILE="$DATA_DIR/bengaluru.osm"
GRAPH_FILE="$DATA_DIR/bengaluru.osrm"

# minLng,minLat,maxLng,maxLat — Overpass's bbox order, which is NOT the same
# order as this codebase's own LatLng convention (lat, then lng). Get this
# backwards and Overpass returns an empty or wildly wrong-shaped box rather
# than an error, so it is spelled out here rather than passed as a mystery
# argument.
BBOX="${OSRM_EXTRACT_BBOX:-77.55,12.80,77.77,13.05}"
OVERPASS_URL="${OSRM_OVERPASS_URL:-https://overpass-api.de/api/map}"

mkdir -p "$DATA_DIR"

echo "==> Downloading OSM extract for bbox=$BBOX from $OVERPASS_URL"
echo "    (this can take several minutes and produce several hundred MB)"
if ! curl --fail --show-error --location \
    --max-time 600 \
    -o "$OSM_FILE" \
    "$OVERPASS_URL?bbox=$BBOX"; then
  echo "!! Download failed. Overpass's public instances rate-limit heavy" >&2
  echo "   requests; retry later, or set OSRM_OVERPASS_URL to a mirror" >&2
  echo "   such as https://overpass.kumi.systems/api/map." >&2
  rm -f "$OSM_FILE"
  exit 1
fi

# A truncated download (a killed connection, a server-side query timeout)
# still writes a file — often even a well-formed-looking one, since Overpass
# closes the XML tag even after reporting an error inside it. The one thing a
# genuinely complete export always ends with is this closing tag, so check
# for it explicitly rather than trusting curl's exit code alone.
if ! tail -c 200 "$OSM_FILE" | grep -q '</osm>'; then
  echo "!! The downloaded file does not end with </osm> — it looks" >&2
  echo "   truncated or Overpass returned an error inside the document." >&2
  echo "   Not running the OSRM pipeline against a possibly-corrupt map." >&2
  exit 1
fi
echo "==> Downloaded $(du -h "$OSM_FILE" | cut -f1)"

# EXTRACT, PARTITION, CUSTOMISE — the three steps this project uses. OSRM
# actually offers two different preprocessing pipelines that are NOT
# interchangeable: extract+contract (the older "contraction hierarchies"
# algorithm) or extract+partition+customise (the newer "multi-level Dijkstra"
# algorithm, MLD). docker-compose.yml's osrm service runs `osrm-routed
# --algorithm mld`, so the pipeline here has to be the matching one — running
# osrm-contract instead would produce files osrm-routed cannot read in MLD
# mode.
echo "==> Running osrm-extract (car profile)"
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-extract -p /opt/car.lua "/data/$(basename "$OSM_FILE")"

echo "==> Running osrm-partition"
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-partition "/data/$(basename "$GRAPH_FILE")"

echo "==> Running osrm-customize"
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-customize "/data/$(basename "$GRAPH_FILE")"

echo "==> Done. Start the routing service with:"
echo "      docker compose up -d osrm"
echo "    and confirm it answers with:"
echo "      curl \"http://localhost:5001/route/v1/driving/77.6245,12.9352;77.6412,12.9719\""
