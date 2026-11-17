# syntax=docker/dockerfile:1

# ── base: Node 24 LTS + pnpm ──
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl: required by the Prisma schema engine (migrations).
RUN apk add --no-cache openssl && npm install --global pnpm@12.16.1
WORKDIR /app

# ── deps: all dependencies (including dev) ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ── build: generates the Prisma client and compiles. Also the image of the migration job ──
FROM deps AS build
COPY . .
RUN pnpm prisma generate && pnpm build

# ── prod-deps: runtime dependencies only ──
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ── runtime: minimal final image, with no toolchain and no root user ──
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
