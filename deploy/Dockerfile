# Single image that can run any OrdoFi service via the SERVICE build/run arg.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Install workspace deps first for layer caching.
COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY apps/watcher/package.json apps/watcher/
COPY apps/gateway/package.json apps/gateway/
COPY apps/auction/package.json apps/auction/
COPY apps/web/package.json apps/web/
RUN npm install --omit=dev --no-audit --no-fund || npm install --no-audit --no-fund

COPY . .

# SERVICE selects which workspace to start: gateway | auction | watcher | web
ENV SERVICE=gateway
EXPOSE 8547 8548 3000
CMD ["sh", "-c", "npm run ${SERVICE}"]
