# Node 22 + IBM MQ redistributable client (pulled by ibmmq's postinstall) + OTel SDK.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# MQIJS_VRM pins the client the postinstall downloads (defaults to latest redist)
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
USER node
CMD ["node", "src/index.mjs"]
