# THE ROUTING SERVICE — self-hosted OSRM with the Delhi road graph baked in.
#
# The same recipe as scripts/setup-osrm.sh, run at image build time instead of
# by hand: download Geofabrik's India northern zone, clip it to Delhi, then
# OSRM's extract/partition/customise. The graph lives in the image rather than
# a volume so a deploy is one artefact — there is no "the container started
# but nobody built the map" state to be in.
#
# Pinned by digest to the image the local docker-compose service runs (it
# reports v5.26.0; Docker Hub has no tag by that name), so
# production routes on exactly what the tests ran against.

FROM debian:bookworm-slim AS clip
RUN apt-get update \
  && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ARG SOURCE_URL=https://download.geofabrik.de/asia/india/northern-zone-latest.osm.pbf
# west,south,east,north — osmium's order. Keep in step with setup-osrm.sh.
ARG BBOX=77.00,28.40,77.45,28.85
WORKDIR /data
RUN curl --fail --show-error --location --user-agent "zippy-osrm-image/1.0" \
      -o source.osm.pbf "$SOURCE_URL" \
  && osmium extract -b "$BBOX" source.osm.pbf -o delhi.osm.pbf \
  && rm source.osm.pbf

FROM osrm/osrm-backend@sha256:af5d4a83fb90086a43b1ae2ca22872e6768766ad5fcbb07a29ff90ec644ee409
WORKDIR /data
COPY --from=clip /data/delhi.osm.pbf /data/delhi.osm.pbf
RUN osrm-extract -p /opt/car.lua /data/delhi.osm.pbf \
  && osrm-partition /data/delhi.osrm \
  && osrm-customize /data/delhi.osrm \
  && rm /data/delhi.osm.pbf

EXPOSE 5000
# Listens on 0.0.0.0, OSRM's default. `--ip ::` (IPv6) crashes at start-up on
# a network with no IPv6 — plain Docker's default — so it is not forced here.
CMD ["osrm-routed", "--algorithm", "mld", "--port", "5000", "/data/delhi.osrm"]
