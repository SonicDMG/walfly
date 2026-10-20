# Walfly API — Next.js, Dockerized, host-agnostic (no Vercel).
#
# MUST be built with the repo root as context, since this is an npm workspace
# and packages/db has to be reachable:
#
#   docker build -f packages/api/Dockerfile -t walfly-api .
#
# (docker-compose.yml at the repo root already does this via `context: .`.)

FROM node:22-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY packages/api/package.json packages/api/package.json
COPY packages/db/package.json packages/db/package.json
# `npm install`, not `npm ci`: this stage only sees a subset of the monorepo's
# package.json files, and npm's workspace lockfile-sync check is stricter than
# that partial view can satisfy (verified by reproducing the same EUSAGE error
# in a bare node:22-slim container, unrelated to this Dockerfile's structure).
# The lockfile still pins every version `npm install` resolves here.
RUN npm install

FROM node:22-slim AS builder
WORKDIR /repo
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/mobile/node_modules ./apps/mobile/node_modules
COPY --from=deps /repo/packages/api/node_modules ./packages/api/node_modules
COPY --from=deps /repo/packages/db/node_modules ./packages/db/node_modules
COPY . .
RUN npm run build --workspace=packages/api

# `output: 'standalone'` (packages/api/next.config.js) + the monorepo-aware
# outputFileTracingRoot there produce .next/standalone/packages/api/server.js
# plus a self-contained node_modules — verified by actually building and
# inspecting the tree, not guessed from the docs.
FROM node:22-slim AS runner
WORKDIR /app
COPY --from=builder /repo/packages/api/.next/standalone ./
COPY --from=builder /repo/packages/api/.next/static ./packages/api/.next/static
RUN chown -R node:node /app
# The official node:22-slim image already ships a non-root `node` user (uid 1000).
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/api/server.js"]
