# ──────────────────────────────────────────────────────────────────────────
# Sales Disposition Reconciliation Portal
#
# Multi-stage. The runtime image carries the Next standalone server and
# nothing else — no source, no dev dependencies, no build toolchain.
#
# BUILD THIS WHERE cdn.sheetjs.com IS REACHABLE. package.json pins SheetJS to
# the official CDN tarball (the npm-registry `xlsx` package is abandoned and
# carries unpatched advisories), and that host is NOT on the VM's outbound
# whitelist. On the Bajaj AI Platform VM the image is loaded, never built:
#
#   podman build -t localhost/reconciliation-app:latest .      # dev machine
#   podman save localhost/reconciliation-app:latest | gzip > recon.tar.gz
#   # move recon.tar.gz to the VM, then:
#   gunzip -c recon.tar.gz | sudo podman load
#
# ──────────────────────────────────────────────────────────────────────────

# ── deps ──────────────────────────────────────────────────────────────────
FROM docker.io/library/node:20-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is re-used whenever source changes but
# dependencies do not — which is most rebuilds.
COPY package.json package-lock.json ./
RUN npm ci

# ── build ─────────────────────────────────────────────────────────────────
FROM docker.io/library/node:20-slim AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# basePath is baked into every route and asset URL at build time, so it is a
# build arg rather than a runtime env var. Building without it and setting it
# later produces a bundle whose links point where nothing is served.
ARG NEXT_PUBLIC_BASE_PATH=""
ENV NEXT_PUBLIC_BASE_PATH=${NEXT_PUBLIC_BASE_PATH}

# `next build` runs `src/lib/env.ts`, which throws on a missing DATABASE_URL.
# These are placeholders for the build only — nothing connects, and the real
# values arrive from the environment at run time.
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    BETTER_AUTH_SECRET="build-time-placeholder-not-a-real-secret-value" \
    BETTER_AUTH_URL="http://localhost:3000" \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────────
FROM docker.io/library/node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3008 \
    HOSTNAME=0.0.0.0

# Non-root. The storage volume is chowned to this uid in docker-compose.shared
# so proof documents are writable without granting the container root.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# `standalone` carries the server plus only the modules it actually reached;
# static/ and public/ are not included in it and must be copied alongside.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Migrations and the drizzle CLI are NOT in this image. Schema changes are
# applied deliberately, by an admin running `npm run db:migrate` against
# shared-postgres — an app that migrates on boot would let a rolled-back
# container restart rewrite the schema under a running one.

USER nextjs
EXPOSE 3008

# Uses the app's own /api/health route rather than a bare TCP check, so a
# process that is up but cannot reach Postgres reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3008'+(process.env.NEXT_PUBLIC_BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
