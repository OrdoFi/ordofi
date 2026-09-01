# Single image that can run any OrdoFi service via the SERVICE build/run arg.
#
# Node 24, not 22: packages/store uses node:sqlite, which Node 22 only exposes
# behind --experimental-sqlite.
FROM node:24-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install workspace deps first for layer caching. Every workspace manifest has
# to be listed — npm resolves the whole graph up front, so a missing one breaks
# the install rather than just that package.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/store/package.json packages/store/
COPY apps/watcher/package.json apps/watcher/
COPY apps/gateway/package.json apps/gateway/
COPY apps/auction/package.json apps/auction/
COPY apps/web/package.json apps/web/
COPY apps/searcher-bot/package.json apps/searcher-bot/
COPY apps/arb-bot/package.json apps/arb-bot/
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

# SERVICE selects which workspace to start: gateway | auction | watcher | web
ENV SERVICE=gateway
EXPOSE 8547 8548 3000
CMD ["sh", "-c", "npm run ${SERVICE}"]
