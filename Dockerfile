# THE APP IMAGE — one image, two processes.
#
# `web` and `worker` are the same code started differently (docs/DEPLOYMENT.md:
# one platform, two always-on processes). Building one image for both means
# the two can never be running different versions of the engine against the
# same database. Which one a container becomes is decided at start-up by
# ZIPPY_PROCESS — see scripts/start-process.sh.

FROM node:20-bookworm-slim

# Prisma's query engine links against OpenSSL, which the slim image omits.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a code-only change reuses this layer. Dev
# dependencies stay installed on purpose: `prisma migrate deploy` runs at
# start-up and the seed runs under tsx, and both are dev dependencies.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts/start-process.sh ./scripts/start-process.sh
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
CMD ["sh", "scripts/start-process.sh"]
