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

# vendor/ holds the SheetJS tarball, which package.json depends on by path
# rather than by URL. It has to be present BEFORE `npm ci`, and copying it with
# the manifests keeps it inside the same cached layer — it changes only when the
# dependency does. See vendor/README.md for why it is committed at all; the
# short version is that neither the VM nor a developer machine behind the
# corporate TLS interception can fetch cdn.sheetjs.com from inside a container.
COPY vendor ./vendor

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

# ── migrate ───────────────────────────────────────────────────────────────
# A one-shot image that applies the schema and exits. Used by the LOCAL
# docker-compose.yml so `docker compose up` produces a working database; the
# VM does not use it (see the note in the runtime stage below).
#
# It reuses the `build` stage rather than adding a slimmer one because the
# migration needs the things a runtime image deliberately drops: drizzle-kit
# and tsx are devDependencies, and `drizzle/`, `scripts/` and
# `drizzle.config.ts` are source. A stage that copied "just enough" would be a
# fourth opinion about what the schema tooling needs.
#
# Placed BEFORE `runtime` on purpose: the last stage is what a bare
# `docker build .` produces, and that must stay the app.
#
# Both scripts call dotenv on `.env.local`, which .dockerignore keeps out of
# the image — so the file is absent, dotenv no-ops, and DATABASE_URL comes
# from the container environment. That is the intended path here; it is also
# why the build-time placeholder DATABASE_URL above must be overridden by
# whatever runs this, and compose's `environment:` does exactly that.
FROM build AS migrate
CMD ["sh", "-c", "npm run db:migrate && npm run db:custom"]

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
#
# The `migrate` stage above exists so LOCAL compose can still bring a database
# up in one command. It is a separate image that runs once and exits, which is
# not the same thing as this one migrating itself on boot: on the VM nothing
# runs it, so the guarantee above is unchanged.

USER nextjs
EXPOSE 3008

# Uses the app's own /api/health route rather than a bare TCP check, so a
# process that is up but cannot reach Postgres reports unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3008'+(process.env.NEXT_PUBLIC_BASE_PATH||'')+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
