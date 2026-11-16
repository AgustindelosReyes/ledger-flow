# syntax=docker/dockerfile:1

# ── base: Node 24 LTS + pnpm ──
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# openssl: requerido por el schema engine de Prisma (migraciones).
RUN apk add --no-cache openssl && npm install --global pnpm@12.16.1
WORKDIR /app

# ── deps: todas las dependencias (incluye dev) ──
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ── build: genera el cliente Prisma y compila. También es la imagen del job de migraciones ──
FROM deps AS build
COPY . .
RUN pnpm prisma generate && pnpm build

# ── prod-deps: solo dependencias de runtime ──
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ── runtime: imagen final mínima, sin toolchain ni usuario root ──
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
