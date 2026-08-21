# syntax=docker/dockerfile:1

FROM node:22-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Build-time placeholder only; the real URL is supplied by docker-compose.
ENV DATABASE_URL=postgresql://admin:nije,kikiriki@postgres:5432/migrator
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY next.config.ts postcss.config.mjs tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

# Keep node_modules because drizzle-kit initializes the application's metadata
# tables on first boot before Next.js starts.
COPY --from=dependencies --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/package-lock.json ./package-lock.json
COPY --from=builder --chown=nextjs:nodejs /app/src/db/schema.ts ./src/db/schema.ts

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["sh", "-c", "npx drizzle-kit push --dialect postgresql --schema ./src/db/schema.ts --url \"$DATABASE_URL\" --force && exec npm run start"]
