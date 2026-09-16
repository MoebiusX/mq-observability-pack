# Node 22 + IBM MQ redistributable client (pulled by ibmmq's postinstall) + OTel SDK.
# Base image pinned by digest (CLAUDE.md rule 5): `docker buildx imagetools inspect node:22-bookworm-slim --format '{{.Manifest.Digest}}'`.
FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# The ibmmq package's postinstall downloads the MQ redistributable client from IBM at build
# time. MQIJS_VRM / MQIJS_FIXPACK pin WHICH client (the module's own default would move with
# each ibmmq release); the value matches the exporter image's VRMF so both MQ clients in the
# lab are the same level. Bumps are a visible diff here.
ENV MQIJS_VRM=10.0.0 MQIJS_FIXPACK=0
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force \
    && /app/node_modules/ibmmq/redist/bin/dspmqver -f 2 | grep -q "10.0.0.0"
COPY src ./src
USER node
CMD ["node", "src/index.mjs"]
