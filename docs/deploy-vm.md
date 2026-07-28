# Deploying to the Bajaj AI Platform VM

**Target:** RHEL 9 at `10.3.5.99`, Podman, the shared stack in `bajaj-ai-infra`.
**URL when done:** `http://10.3.5.99/reconciliation`

The platform runs one shared stack — `shared-postgres`, `shared-redis`,
`shared-nginx` — and every agent joins it. `shared-nginx` is the only container
that binds a host port and routes to agents by path.

| Item | Value |
|---|---|
| Agent name | `reconciliation` |
| Nginx path | `/reconciliation/` |
| Container | `reconciliation-app:3008` |
| Database | `reconciliation_db`, owner `reconciliation_user` |
| Host ports | none |
| Repo path on VM | `/opt/reconciliation-agent/` |

Port 3008 is the next free frontend slot in `bajaj-ai-infra/docs/port-registry.md`
(3004 and 3006 are reserved for hr and voice). This agent runs **one** container,
not the usual frontend/backend pair — it is a Next.js server that owns both the
UI and the Server Actions. `monitoring-agent` already sets the precedent.

`/reconciliation/` rather than `/sales/`: `basePath: '/sales'` would put the
salesperson's own dashboard at `/sales/sales`, and the platform path would
collide with a role prefix inside the app.

---

## Read this before you start

Four things will break this deployment. Three of them fail silently.

### 1. Build the image where `cdn.sheetjs.com` is reachable

`package.json` pins SheetJS to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
— the official distribution, because the `xlsx` package on the public npm
registry is abandoned and its last release carries unpatched prototype-pollution
and ReDoS advisories.

**`cdn.sheetjs.com` is not on the outbound whitelist** in `infra-access-request.md`.
`npm ci` will fail on the VM. Build elsewhere and move the image (below), or get
the host whitelisted, or vendor the tarball into the repo.

### 2. `client_max_body_size 64m` on the nginx location blocks

nginx defaults to **1 MB**. The source workbook is 9.14 MB and a correction
carries up to five 10 MB proofs. Without it, every import and every proof upload
returns 413 from the proxy — and the application's own size checks, which return
a message naming the offending file, never run. Already set in
`deploy/nginx-reconciliation.conf`; do not drop it.

### 3. Timeouts, and why the blocks do not `include proxy_params.conf`

`proxy_params.conf` sets `proxy_read_timeout 60s`. Committing 1,171 rows plus
their version snapshots can exceed that. The blocks need 180s — and re-declaring
`proxy_read_timeout` alongside the `include` is an nginx `[emerg]` that takes
**the whole platform's** config down, not just this route. So the blocks spell
their proxy headers out instead. `/seo/api/` already does the same thing for the
same reason.

### 4. Secure cookies over a plain-HTTP ingress — a known gap

`shared-nginx` listens on `:80` only. A `Secure` session cookie is accepted by
the browser and then never sent back, which presents as an infinite login loop
that looks like a wrong password. `COOKIE_SECURE=false` in
`docker-compose.shared.yml` works around it.

**This is a real weakening.** Session cookies cross the corporate LAN in clear
text and anyone on-path can replay one for the eight hours it lives. It is a
stopgap, not a decision: terminate TLS at `shared-nginx` and set `COOKIE_SECURE`
back to `true`. `bajaj-ai-infra/shared/certs/` already exists for it.

---

## Changes needed in `bajaj-ai-infra`

**1. `shared/init-db.sh`** — add the database and its least-privilege role,
following the existing per-agent pattern:

```bash
create_agent_db "reconciliation" "$RECONCILIATION_DB_PASSWORD"
```

**2. `shared/.env`** — add `RECONCILIATION_DB_PASSWORD=<generated>`. It must
match the value this agent's own `.env` uses.

**3. `shared/nginx.conf`** — paste `deploy/nginx-reconciliation.conf` inside the
`BEGIN LOCATIONS` / `END LOCATIONS` markers. Keep the marker comments intact or
`add-agent-route.sh` will not know where to insert next time.

**4. `docs/port-registry.md`** — add the row:

```
| reconciliation   | reconciliation-app:3008¹ | —                       | /reconciliation/ | active   |
```

> ¹ Single container: a Next.js server owning both UI and Server Actions, so
> there is no separate backend. Occupies the frontend slot only.

and under Databases:

```
| reconciliation   | reconciliation_db | reconciliation_user | active |
```

---

## Deploy

### On a machine with CDN access

```bash
podman build \
  --build-arg NEXT_PUBLIC_BASE_PATH=/reconciliation \
  -t localhost/reconciliation-app:latest .

podman save localhost/reconciliation-app:latest | gzip > reconciliation-app.tar.gz
```

`NEXT_PUBLIC_BASE_PATH` is a **build** arg, not a runtime variable: Next bakes
`basePath` into every emitted route and asset URL, so setting it later gives you
a bundle whose links point where nothing is served.

### On the VM

```bash
# 1. Load the image (pull_policy: never means it must be present locally)
gunzip -c reconciliation-app.tar.gz | sudo podman load

# 2. Place the deployment files
sudo mkdir -p /opt/reconciliation-agent
sudo cp docker-compose.shared.yml /opt/reconciliation-agent/
cd /opt/reconciliation-agent

# 3. Environment. BETTER_AUTH_SECRET must be 32+ chars and must NOT be
#    regenerated on redeploy — changing it invalidates every live session.
sudo tee .env >/dev/null <<'EOF'
RECONCILIATION_DB_PASSWORD=<same value as in shared/.env>
BETTER_AUTH_SECRET=<32+ random chars, generated once and kept>
EOF
sudo chmod 600 .env

# 4. Create the database (run from the shared stack, once)
cd /opt/shared && sudo bash scripts/init-db.sh   # or the documented equivalent
cd /opt/reconciliation-agent

# 5. Start
sudo podman-compose -f docker-compose.shared.yml up -d

# 6. Schema. Deliberately NOT run by the container on boot: an app that
#    migrates at startup lets a rolled-back container rewrite the schema under
#    a running one. Run it from a machine that can reach shared-postgres:
#      DATABASE_URL=postgresql://reconciliation_user:...@10.3.5.99:5432/reconciliation_db \
#        npm run db:migrate && npm run db:custom
#    (shared-postgres publishes no host port, so run this from inside the
#     network, e.g. `podman run --rm --network shared-network ...`.)

# 7. Route
sudo podman exec shared-nginx nginx -t
sudo podman exec shared-nginx nginx -s reload

# 8. First admin — refuses to run once any user exists
sudo podman exec -it reconciliation-app node -e "require('./scripts/setup-admin.js')"
#    or reach /reconciliation/setup in a browser, which 404s after first use.
```

### Verify

```bash
curl -I http://10.3.5.99/reconciliation            # 200, not 301
curl -I http://10.3.5.99/reconciliation/           # 308 -> /reconciliation
curl    http://10.3.5.99/reconciliation/api/health # ok
sudo podman logs --tail 50 reconciliation-app
```

A 301 on the first line means the exact-match `location = /reconciliation`
block is missing and you are in the redirect loop described in the conf file.

---

## Roles to create after first login

The flow needs all four. An admin who creates only sales and approver accounts
gets a portal where every correction stops dead at a verification queue nobody
can open.

| Role | SM_ID | Purpose |
|---|---|---|
| `admin` | none | Imports workbooks, manages accounts and periods, exports |
| `sales` | required | Sees only their own records, raises corrections |
| `verifier` | none | First review — checks a request against its proof |
| `approver` | none | Second review — applies, rejects or returns |

If no active verifier exists, submissions succeed but reach nobody. The
submitting rep is not told; the count is recorded on the `CORRECTION_SUBMIT`
audit row as `verifiersNotified: 0` and shown to the verifier who eventually
looks. Create at least one verifier before going live.

---

## Redeploying

```bash
# Rebuild and move the image as above, then on the VM:
cd /opt/reconciliation-agent
sudo podman-compose -f docker-compose.shared.yml down
gunzip -c reconciliation-app.tar.gz | sudo podman load
sudo podman-compose -f docker-compose.shared.yml up -d
```

The `reconciliation-storage` volume survives this. It holds uploaded workbooks,
proof attachments and generated exports — customer documents, and the evidence
that a record's original value was what it claims. Never `podman volume rm` it
as part of a redeploy.

## Logging

`docker-compose.shared.yml` uses the podman `k8s-file` driver, capping
`/var/log/apps/reconciliation.log` at 200 MB, matching the platform's overlay
convention. Create the directory once:

```bash
sudo mkdir -p /var/log/apps
```

Docker Desktop rejects `k8s-file`, so this compose file is **podman-only**. Local
development uses `docker-compose.yml`, which is unchanged.
