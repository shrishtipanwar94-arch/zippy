#!/usr/bin/env bash
# ONE-TIME OSRM SETUP — run this once (and again only if the map data should
# be refreshed), not on every `docker compose up`.
#
# Downloads the road network around Delhi — the city every seeded zone
# (prisma/seed/zones.ts) is in — and runs OSRM's three preprocessing steps
# into ./osrm/data, which docker-compose.yml's `osrm` service then serves.
# This is a genuinely separate step from starting the container: OSRM does not
# download or build its own map data, and building it takes real time and
# disk, which is exactly why it happens once, by hand, rather than inside
# `docker compose up`.
#
# WHY DELHI: the seed picked it. Nothing here decides the city; it just builds
# the map the seed already committed to. (The project began in Bengaluru and
# moved; changing city means changing the seed, the source and box below, and
# running this again.)
#
# WHERE THE MAP COMES FROM: Geofabrik's India "northern zone" (Delhi, Haryana,
# Punjab, Rajasthan and the hill states, ~220MB), clipped with osmium to a box
# around Delhi (~28MB). A previous version asked the public Overpass API for
# the box directly; for a metro this size both overpass-api.de and its kumi
# mirror answered 500/502, so the script now starts from a file Geofabrik
# rebuilds daily and is far less likely to be refused.
#
# THE ZONE STOPS AT THE UTTAR PRADESH BORDER. Ghaziabad and Noida are in a
# different Geofabrik zone, so the clipped graph has almost no roads east of
# the Yamuna's far bank — measured: 35 road ways in a box over Vaishali against
# 8,329 in a same-sized box around Connaught Place. That is why every seeded
# zone is inside the NCT.
#
# Requires Docker and network access to download.geofabrik.de. If the download
# fails the script exits rather than preprocessing a partial file — a corrupt
# city-shaped hole in the road network is a much worse failure than "the
# script didn't run."

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/osrm/data"
SOURCE_URL="${OSRM_SOURCE_URL:-https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf}"
SOURCE_FILE="$DATA_DIR/northern-zone.osm.pbf"
OSM_FILE="$DATA_DIR/delhi.osm.pbf"
GRAPH_FILE="$DATA_DIR/delhi.osrm"

# west,south,east,north — osmium's bbox order, which is NOT this codebase's
# own LatLng convention (lat, then lng). Spelled out so nobody has to guess.
BBOX="${OSRM_EXTRACT_BBOX:-77.00,28.40,77.45,28.85}"

mkdir -p "$DATA_DIR"

# GIT BASH ON WINDOWS rewrites any argument that looks like a POSIX path, so
# the container path "/data/x.pbf" arrived inside the container as
# "C:/Program Files/Git/data/x.pbf". The rewrite is switched off for docker
# calls ONLY — curl is a native Windows binary and needs it to find its own
# output path — and Docker is handed the Windows form of the host path
# (`pwd -W`, which only Git Bash has). All of this is a no-op on Linux/macOS.
DOCKER_DATA_DIR="$DATA_DIR"
if WINDOWS_PATH="$(cd "$DATA_DIR" && pwd -W 2>/dev/null)"; then
  DOCKER_DATA_DIR="$WINDOWS_PATH"
fi
run_in_docker() {
  MSYS_NO_PATHCONV=1 docker run --rm -v "$DOCKER_DATA_DIR:/data" "$@"
}

echo "==> Downloading $SOURCE_URL"
# Geofabrik asks clients to identify themselves; an anonymous curl is the
# first thing a busy mirror refuses.
if ! curl --fail --show-error --location \
    --user-agent "zippy-setup-osrm/1.0" \
    -o "$SOURCE_FILE" \
    "$SOURCE_URL"; then
  echo "!! Download failed. Retry later, or set OSRM_SOURCE_URL to another" >&2
  echo "   .osm.pbf that covers Delhi." >&2
  rm -f "$SOURCE_FILE"
  exit 1
fi
echo "==> Downloaded $(du -h "$SOURCE_FILE" | cut -f1)"

# CLIPPED BEFORE OSRM SEES IT, because preprocessing time and the graph's
# memory footprint scale with the input. A 220MB state-sized graph would need
# several GB of RAM in the deployed routing service for no benefit.
echo "==> Clipping to bbox=$BBOX with osmium"
run_in_docker iboates/osmium:latest \
  extract -b "$BBOX" "/data/$(basename "$SOURCE_FILE")" -o "/data/$(basename "$OSM_FILE")" --overwrite
echo "==> Clipped to $(du -h "$OSM_FILE" | cut -f1)"

# EXTRACT, PARTITION, CUSTOMISE — the three steps this project uses. OSRM
# actually offers two different preprocessing pipelines that are NOT
# interchangeable: extract+contract (the older "contraction hierarchies"
# algorithm) or extract+partition+customise (the newer "multi-level Dijkstra"
# algorithm, MLD). docker-compose.yml's osrm service runs `osrm-routed
# --algorithm mld`, so the pipeline here has to be the matching one — running
# osrm-contract instead would produce files osrm-routed cannot read in MLD
# mode.
echo "==> Running osrm-extract (car profile)"
run_in_docker osrm/osrm-backend \
  osrm-extract -p /opt/car.lua "/data/$(basename "$OSM_FILE")"

echo "==> Running osrm-partition"
run_in_docker osrm/osrm-backend \
  osrm-partition "/data/$(basename "$GRAPH_FILE")"

echo "==> Running osrm-customize"
run_in_docker osrm/osrm-backend \
  osrm-customize "/data/$(basename "$GRAPH_FILE")"

echo "==> Done. Start the routing service with:"
echo "      docker compose up -d osrm"
echo "    and confirm it answers with:"
echo "      curl \"http://localhost:5001/route/v1/driving/77.2095,28.6152;77.2262,28.6519\""
