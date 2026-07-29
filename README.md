# Sales Disposition Reconciliation Portal

An admin imports the monthly sales workbook; each SM sees only their own records
and raises corrections against them; a **verifier** checks each request before an
**approver** can act on it. Records and corrections are tagged with a monthly
period that the admin opens and closes.

Workbook parsing runs in a separate Python service (`ingest/`) because the source
`.xlsb` takes ~74 s to read in Node and ~0.3 s through calamine, and its
`Lead Dump` sheet declares a 54,508 × 16,383 range that any reader materialising
it dies on.

## Running it

```bash
docker compose up -d --build      # first run, or after a code change
docker compose up -d              # afterwards
```

That is the whole pipeline: Postgres, the migrations, the parser and the portal.

| | |
|---|---|
| Portal | <http://localhost:3000> |
| Parser health | <http://localhost:8006/health> |
| Postgres | `postgresql://sdrp:sdrp_local_dev@localhost:5432/sdrp` |

You need an `.env.local` first — `cp .env.example .env.local` and set
`BETTER_AUTH_SECRET` to 32+ random characters. The app container reads that file
for its secrets; everything else it needs is set in `docker-compose.yml`.

`docker compose ps` should show four entries. `sdrp-migrate` **exiting with code
0 is correct** — it applies the schema and stops. If `sdrp-ingest` is restarting,
read its log: it validates on startup that every column it writes exists and
refuses to serve otherwise, so it names the missing table rather than failing on
your first upload.

The first admin account is created by `npm run setup:admin`, which refuses to run
once any user exists.

### Working on the UI

Run the portal on the host so you get hot reload, and leave the rest in Docker:

```bash
docker compose up -d postgres migrate ingest
npm run dev                       # http://localhost:3000
```

Both ways use the same database and the same `storage/` directory, so you can
switch between them without re-uploading anything. A containerised Next dev
server watching a Windows bind mount rebuilds seconds after you save, when it
notices at all — which is why it is not wired up that way.

### Tests

```bash
npm test                          # the portal — Vitest, against DATABASE_URL_TEST
cd ingest && python -m pytest     # the parser
```

The portal's tests share one database and therefore run with
`fileParallelism: false`. Create it once with `npm run db:migrate:test` and
`npm run db:custom:test`.

## How the pieces fit

```
                       ┌──────────────┐
   browser ──────────► │  app  :3008  │ ──────► postgres :5432
                       └──────┬───────┘              ▲
                              │ stored path          │
                              ▼                      │
                       ┌──────────────┐              │
                       │ ingest :8006 │ ─────────────┘
                       └──────┬───────┘
                              ▼
                     ./storage (shared volume)
```

The portal writes an uploaded workbook to `storage/` and hands the parser only
the **relative path** — a 9 MB file never crosses the network. Both containers
mount the same directory, and that sharing *is* the integration: point them at
different volumes and every parse fails with `No stored file at ...` while both
containers stay green.

The parser is reachable on `8006` locally only so a host-side `npm run dev` can
call it. On the VM it publishes no port at all and is protected by one shared
secret, `INGEST_TOKEN`. A wrong token gets a **404, never a 401** — deliberately,
so the service does not confirm its own existence to anything probing the shared
network. The practical consequence: a token mismatch presents as "the parser lost
my job", not as an auth failure.

## Deploying

`docker-compose.shared.yml` targets the Bajaj AI Platform VM (RHEL 9, Podman,
the shared `postgres`/`redis`/`nginx` stack at 10.3.5.99). It is **podman-only** —
it joins an external network, publishes no ports, and uses the `k8s-file` log
driver that Docker Desktop rejects.

Read `docs/deploy-vm.md` before deploying. It lists seven things that break the
deployment, six of them silently.

## Layout

| Path | |
|---|---|
| `src/app` | Next.js App Router — one directory per role |
| `src/lib` | The domain: `import`, `corrections`, `verification`, `approvals`, `periods`, `leads` |
| `src/db/schema` | Drizzle schema — the single source of truth, including the two tables the Python service writes |
| `drizzle/` | Generated migrations, plus `custom/` for what drizzle-kit cannot express (partial unique indexes, triggers) |
| `ingest/` | The FastAPI parser |
| `vendor/` | The SheetJS tarball, committed — see `vendor/README.md` |
| `docs/` | Specs and the deployment guide |
