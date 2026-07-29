# Deploying to the Bajaj AI Platform VM

**Target:** RHEL 9 at `10.3.5.99`, Podman, the shared stack in `bajaj-ai-infra`.
**URL when done:** `http://10.3.5.99/reconciliation`

The platform runs one shared stack — `shared-postgres`, `shared-redis`,
`shared-nginx` — and every agent joins it. `shared-nginx` is the only container
that binds a host port and routes to agents by path.

| Item | Value |
|---|---|
| Agent name | `reconciliation` |
| Nginx path | `/reconciliation/` — the app only; the ingest service has none |
| Containers | `reconciliation-app:3008`, `reconciliation-ingest:8006` |
| Database | `reconciliation_db`, owner `reconciliation_user` — **shared** by both |
| Shared volume | `reconciliation-storage` at `/app/storage` in **both** |
| Host ports | none |
| Repo path on VM | `/opt/reconciliation-agent/` |

Port 3008 is the next free frontend slot in `bajaj-ai-infra/docs/port-registry.md`
(3004 and 3006 are reserved for hr and voice). `reconciliation-app` is a Next.js
server that owns both the UI and the Server Actions, so it fills that slot on its
own rather than as half of the usual frontend/backend pair — `monitoring-agent`
already sets the precedent for an agent that does not fill both columns.

`reconciliation-ingest` is the second container: a Python/FastAPI service that
parses the workbooks and inspects the PDF proofs, because the source `.xlsb`
costs ~74.6 s through SheetJS in Node and 0.33 s through calamine in Python
(`docs/superpowers/specs/2026-07-28-ingestion-service-design.md`). It takes the
backend slot, so the agent now fills both columns of the registry.

It listens on **8006, not 8005** — 8005 was the next free backend number, and it
falls inside a Windows TCP port-exclusion range (Hyper-V/WinNAT; see
`netsh interface ipv4 show excludedportrange protocol=tcp`) on the developer
machines. Binding it fails with a bare "permission denied" naming neither
Windows nor the exclusion, which costs an afternoon every time somebody runs the
service outside a container. The VM does not care; a port that works in only one
of two supported environments is still a trap. 8005 is left unassigned in the
registry so the next agent does not walk into it.

`reconciliation-ingest` has **no nginx route**, and adding one would be a
mistake — see failure mode 6 below.

`/reconciliation/` rather than `/sales/`: `basePath: '/sales'` would put the
salesperson's own dashboard at `/sales/sales`, and the platform path would
collide with a role prefix inside the app.

---

## Read this before you start

Seven things will break this deployment. Six of them fail silently.

### 1. Build the **portal** image where `cdn.sheetjs.com` is reachable

`package.json` pins SheetJS to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
— the official distribution, because the `xlsx` package on the public npm
registry is abandoned and its last release carries unpatched prototype-pollution
and ReDoS advisories.

**`cdn.sheetjs.com` is not on the outbound whitelist** in `infra-access-request.md`.
`npm ci` will fail on the VM. Build elsewhere and move the image (below), or get
the host whitelisted, or vendor the tarball into the repo.

This applies to `Dockerfile` only. `ingest/Dockerfile` needs nothing but PyPI —
every one of its requirements resolves to a prebuilt wheel — so it is the one
image that *could* be built on the VM. It is still built alongside the other, for
the reason given under Deploy.

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

### 5. Both containers must mount the *same* `reconciliation-storage` volume

This shared volume **is** the integration. The portal writes the uploaded
workbook to it and hands `reconciliation-ingest` only the stored *path*; the file
itself never crosses the network. Nine megabytes of `.xlsb` through an HTTP body,
buffered twice, would be slower than the parse it exists to feed.

Point the two containers at different volumes — or bind-mount one of them "just
to look at the files" — and every parse fails with `No stored file at ...` while
**both containers stay green**: neither one is broken, the pairing is. There is
nothing in either container's logs that says "wrong volume".

Both images also run as **uid 1001**, deliberately. The portal is the writer, so
every file under the volume is owned by 1001; an ingest container running as
anything else reads customer proofs through the world bits alone and cannot write
beside them at all. If you change the user in either `Dockerfile`, change both.

### 6. `INGEST_TOKEN` is the entire security boundary — 32+ chars, same on both

`reconciliation-ingest` binds no host port, but `shared-network` carries every
agent on the platform, and any container on it can open
`reconciliation-ingest:8006`. There is no session, no user and no second factor:
the shared token in `X-Ingest-Token` is all of it. The service refuses to start
on anything shorter than 32 characters, because a short secret that looks like a
control is worse than no control.

Two consequences worth knowing before you debug this at 6pm:

- **A mismatch does not look like an auth failure.** A wrong or missing token
  gets a **404**, never a 401 — deliberate, so the service does not confirm its
  own existence to anything probing shared-network. A typo in one of the two
  copies therefore presents as "the parser lost my job", not "the parser rejected
  me". Generate once, paste into both, never rotate one side alone.
- **Do not give it an nginx route to "make it testable".** It authenticates no
  humans and has no UI, so a public location block would put an
  unauthenticated-by-design service on the platform's ingress, with one header
  the browser never sends as its only protection. The reasoning is recorded in
  `deploy/nginx-reconciliation.conf` where somebody would go to add it.

### 7. Start the shared stack first, or the ingest container crash-loops

`reconciliation-ingest` opens its connection pool and validates the schema during
startup, before it serves anything. With `shared-postgres` unreachable that
startup fails after a 30-second pool timeout, uvicorn exits, and
`restart: unless-stopped` starts it again — a loop that repeats every ~30 s and
reads like this:

```
psycopg_pool.PoolTimeout: couldn't get a connection after 30.00 sec
ERROR:    Application startup failed. Exiting.
```

That is start order or a wrong `RECONCILIATION_DB_PASSWORD`, not a broken image.
The same message appears for both, so check the shared stack is up *first*, then
the password. `shared/scripts/start-all.sh` already sequences this correctly.

Failing at startup rather than serving is the intended behaviour: a parser that
accepts jobs it cannot record is worse than one that is visibly down.

---

## Changes in `bajaj-ai-infra` — ALREADY APPLIED

Everything in this section is done in the infra repo. It is kept as a record of
what was changed and why, not as a checklist. Verify rather than re-apply.

The agent's deployment files now live at
**`bajaj-ai-platform/reconciliation-agent/`** in that repo, alongside every
other agent, because `shared/scripts/start-all.sh` iterates `/opt/*/` looking
for `docker-compose.shared.yml` — an agent whose compose file exists only in its
source repo is one start-all.sh cannot start. That directory holds a **copy** of
this repo's `docker-compose.shared.yml` and `deploy/nginx-reconciliation.conf`,
plus its own `.env.example` and `README.md`. This repo's copy stays
authoritative; if you change one, change both.

**1. `shared/init-db.sh`** — creates the database and its least-privilege role:

```bash
create_role "reconciliation_user" "${RECONCILIATION_DB_PASSWORD:-reconciliation_pass}"
create_db   "reconciliation_db"   "reconciliation_user"
```

**2. `shared/.env.example`** — carries `RECONCILIATION_DB_PASSWORD`. It must
match the value this agent's own `.env` uses. Note the `:-reconciliation_pass`
fallback above: leaving it unset does not fail, it creates the role with a
password nothing else knows, and the symptom is a pool timeout rather than an
auth error.

**3. `shared/nginx.conf`** — the two location blocks are already inside the
`BEGIN LOCATIONS` / `END LOCATIONS` markers. Keep the marker comments intact or
`add-agent-route.sh` will not know where to insert next time. Validated with
`nginx -t` against `nginx:alpine`.

**4. `shared/scripts/check-health.sh`** — probes `/reconciliation` (no trailing
slash — the slashed form 308s) and `/reconciliation/api/health`.

**5. `docs/port-registry.md`** — carries the row:

```
| reconciliation-agent | reconciliation-app:3008² | reconciliation-ingest:8006³ | /reconciliation/ | active |
```

> ² `reconciliation-app` is a Next.js server owning both UI and Server Actions,
> so it fills the frontend slot on its own.
>
> ³ `reconciliation-ingest` is the Python parser. It takes the backend slot at
> **8006**, not 8005 (Windows port exclusion — see above), so 8005 stays
> unassigned and the next free backend port is 8007. **No nginx path**: it is
> internal-only by design.

and under Databases:

```
| reconciliation   | reconciliation_db | reconciliation_user | active |
```

**6. `shared/init-db.sh`** — **nothing more to do.** `reconciliation-ingest`
uses the same `reconciliation_db` and the same `reconciliation_user` login as
the portal, so the `create_role` / `create_db` pair added in step 1 already
covers both containers. This is deliberate, not laziness: the two write disjoint
tables (Drizzle migrations own the schema; the ingest service runs no DDL and
writes only `ingest_job`, `upload_batch_row` and `lead`, refusing to start if
those columns are missing). A second database would put the job rows somewhere
the portal cannot join them from, which is the one thing the design depends on
not happening.

---

## Deploy

### On a machine with CDN access

```bash
# The portal
podman build \
  --build-arg NEXT_PUBLIC_BASE_PATH=/reconciliation \
  -t localhost/reconciliation-app:latest .

podman save localhost/reconciliation-app:latest | gzip > reconciliation-app.tar.gz

# The parser. Context is ingest/, not the repo root — the Dockerfile COPYs
# requirements.txt and app/ relative to it.
podman build -f ingest/Dockerfile -t localhost/reconciliation-ingest:latest ingest/

podman save localhost/reconciliation-ingest:latest | gzip > reconciliation-ingest.tar.gz

# The migration runner — a one-shot image that applies the schema and exits.
# NOT in docker-compose.shared.yml and it must not be; see step 6 below. It is a
# named stage of the same Dockerfile, so this costs one extra export, not an
# extra build.
podman build --target migrate -t localhost/reconciliation-migrate:latest .

podman save localhost/reconciliation-migrate:latest | gzip > reconciliation-migrate.tar.gz
```

`NEXT_PUBLIC_BASE_PATH` is a **build** arg, not a runtime variable: Next bakes
`basePath` into every emitted route and asset URL, so setting it later gives you
a bundle whose links point where nothing is served.

The ingest image has **no build arg and no CDN dependency** — every requirement,
`python-calamine` (a Rust extension) included, resolves to a manylinux wheel, so
its install stage runs `pip install --only-binary=:all:` and no compiler is
installed in either stage. It could therefore be built on the VM. Build it here
anyway: `pull_policy: never` means the image has to be present locally either
way, and one deployment path is easier to keep correct than two.

If a future dependency ever ships source-only, the build fails in the `deps`
stage with pip naming the package. Fix it by adding the toolchain to **that
stage only** — the multi-stage split exists precisely so a compiler cannot leak
into the runtime image.

### On the VM

```bash
# 1. Load BOTH images (pull_policy: never means they must be present locally)
gunzip -c reconciliation-app.tar.gz    | sudo podman load
gunzip -c reconciliation-ingest.tar.gz | sudo podman load

# 2. Place the deployment files
sudo mkdir -p /opt/reconciliation-agent
sudo cp docker-compose.shared.yml /opt/reconciliation-agent/
cd /opt/reconciliation-agent

# 3. Environment. BETTER_AUTH_SECRET must be 32+ chars and must NOT be
#    regenerated on redeploy — changing it invalidates every live session.
#
#    INGEST_TOKEN must ALSO be 32+ chars (the ingest service refuses to start
#    otherwise) and is read by BOTH containers from this one file, so they
#    cannot drift. Generate it once: openssl rand -hex 32
sudo tee .env >/dev/null <<'EOF'
RECONCILIATION_DB_PASSWORD=<same value as in shared/.env>
BETTER_AUTH_SECRET=<32+ random chars, generated once and kept>
INGEST_TOKEN=<32+ random chars, generated once and kept>
EOF
sudo chmod 600 .env

# 4. Create the database (run from the shared stack, once)
cd /opt/shared && sudo bash scripts/init-db.sh   # or the documented equivalent
cd /opt/reconciliation-agent

# 5. Start (the shared stack must already be up — see failure mode 7)
sudo podman-compose -f docker-compose.shared.yml up -d

# 6. Schema. Deliberately NOT run by the container on boot: an app that
#    migrates at startup lets a rolled-back container rewrite the schema under
#    a running one. Run it from a machine that can reach shared-postgres:
#      DATABASE_URL=postgresql://reconciliation_user:...@10.3.5.99:5432/reconciliation_db \
#        npm run db:migrate && npm run db:custom
#    (shared-postgres publishes no host port, so run this from inside the
#     network, e.g. `podman run --rm --network shared-network ...`.)
#
#    EXPECTED on a first deployment: between step 5 and this step,
#    reconciliation-ingest crash-loops with "table 'ingest_job' is missing
#    entirely". It validates on startup that every column it writes exists and
#    refuses to start otherwise, so on an empty database it cannot start — by
#    design, because the alternative is a parser that accepts jobs it cannot
#    record. It settles by itself once the migrations land. If it is still
#    looping after them, the schema really is wrong; read the message, it names
#    the table and column.

# 7. Route
sudo podman exec shared-nginx nginx -t
sudo podman exec shared-nginx nginx -s reload

# 8. First admin — refuses to run once any user exists
sudo podman exec -it reconciliation-app node -e "require('./scripts/setup-admin.js')"
#    or reach /reconciliation/setup in a browser, which 404s after first use.
```

### Verify — the portal

```bash
curl -I http://10.3.5.99/reconciliation            # 200, not 301
curl -I http://10.3.5.99/reconciliation/           # 308 -> /reconciliation
curl    http://10.3.5.99/reconciliation/api/health # ok
sudo podman logs --tail 50 reconciliation-app
```

A 301 on the first line means the exact-match `location = /reconciliation`
block is missing and you are in the redirect loop described in the conf file.

### Verify — the ingest service

There is no URL to curl from your laptop, and that is the point: the service is
internal-only. Every check below runs *inside* the network.

```bash
# 1. It is running and its own healthcheck agrees. `healthy` means the /health
#    route answered 200, which it only does after `select 1` succeeds through
#    the pool — so this covers "can reach shared-postgres" too, not just "the
#    process is alive".
sudo podman ps --filter name=reconciliation-ingest \
     --format '{{.Names}}  {{.Status}}'          # ... (healthy)

# 2. What it reports.
sudo podman exec reconciliation-ingest \
  python -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8006/health').read().decode())"
# {"status":"ok","database":"up"}

# 3. The portal can actually reach it by container name — the thing that
#    breaks if the two land on different networks.
sudo podman exec reconciliation-app \
  node -e "fetch('http://reconciliation-ingest:8006/health').then(r=>r.text()).then(console.log)"

# 4. It is NOT exposed. The first proves no host port; the second proves no
#    nginx route — there is no /ingest location, so the request falls through
#    to the landing SPA's catch-all and you get platform HTML back, never the
#    service. If either one ever returns {"status":"ok"}, something published
#    it and that is the bug.
curl -sS --max-time 5 http://10.3.5.99:8006/health   ; echo "  <- expect refused"
curl -sS http://10.3.5.99/ingest/health | head -3     # landing HTML, not JSON

# 5. The shared volume is genuinely shared — the same file, from both sides.
sudo podman exec reconciliation-app    ls -la /app/storage/uploads | head
sudo podman exec reconciliation-ingest ls -la /app/storage/uploads | head

# 6. It runs unprivileged, as the same uid the portal writes files with.
sudo podman exec reconciliation-ingest id     # uid=1001(ingest) gid=1001(ingest)

sudo podman logs --tail 50 reconciliation-ingest
```

Reading the failures:

| What you see | What it is |
|---|---|
| `PoolTimeout: couldn't get a connection` then `Application startup failed` | shared-postgres unreachable, or `RECONCILIATION_DB_PASSWORD` does not match `shared/.env`. Failure mode 7. |
| `table 'ingest_job' is missing entirely` | Migrations have not been run against `reconciliation_db` yet — step 6. |
| `INGEST_TOKEN must be at least 32 characters` | Exactly that. It will not start; it is not a warning. |
| Container `healthy`, but every import fails with `No stored file at ...` | The two containers are not on the same `reconciliation-storage` volume. Failure mode 5. |
| Container `healthy`, imports return 404 from the portal | The two `INGEST_TOKEN` values differ. A bad token is answered 404, not 401 — failure mode 6. |
| Container `unhealthy` while nothing else changed | Postgres went away *after* startup. `/health` returns 503 and the healthcheck fails, which is the point of probing the route instead of the port. |

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
# Rebuild and move the image(s) as above, then on the VM:
cd /opt/reconciliation-agent
sudo podman-compose -f docker-compose.shared.yml down
gunzip -c reconciliation-app.tar.gz    | sudo podman load   # if it changed
gunzip -c reconciliation-ingest.tar.gz | sudo podman load   # if it changed
sudo podman-compose -f docker-compose.shared.yml up -d
```

The two images version independently — a portal-only change does not need a new
ingest image, and vice versa — but `down`/`up` cycles both, because they share
the volume and the database and a half-restarted pair is harder to reason about
than a five-second outage. Reload the images you actually rebuilt; `podman load`
of an unchanged tarball is harmless but slow.

Do **not** reload only one of them after changing `INGEST_TOKEN`. The token is
read from `.env` at container start, so a one-sided restart leaves the pair
disagreeing, and the symptom is a 404 that reads like a lost job (failure mode
6).

The `reconciliation-storage` volume survives this. It holds uploaded workbooks,
proof attachments and generated exports — customer documents, and the evidence
that a record's original value was what it claims. Never `podman volume rm` it
as part of a redeploy. Note that it is now the *only* thing carrying uploaded
files between the two containers, so removing it does not merely lose history —
it breaks every future import until something writes to it again.

## Logging

`docker-compose.shared.yml` uses the podman `k8s-file` driver, capping each log
at 200 MB, matching the platform's overlay convention:

| Container | Log |
|---|---|
| `reconciliation-app` | `/var/log/apps/reconciliation.log` |
| `reconciliation-ingest` | `/var/log/apps/reconciliation-ingest.log` |

Separate files on purpose: a failed import is almost always one service's fault,
and interleaving Next.js request lines with a 54,507-row parse's progress makes
that harder to see, not easier. Create the directory once:

```bash
sudo mkdir -p /var/log/apps
```

The ingest image sets `PYTHONUNBUFFERED=1`. Without it uvicorn's lines sit in a
pipe buffer and reach `/var/log/apps` minutes late, which during an incident
reads as "the service stopped logging".

No customer data reaches either log. The ingest service reports row *numbers*,
never cell values — a log tail is not a data export.

Docker Desktop rejects `k8s-file`, so this compose file is **podman-only**. Local
development uses `docker-compose.yml`, which is unchanged.
