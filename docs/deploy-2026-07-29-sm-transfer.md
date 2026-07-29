# Deploy runbook — SM-to-SM transfer + auth fix

**Release:** `45a05d1` on `main`
**Target:** `reconciliation` agent on `10.3.5.99`
**Base procedure:** `docs/deploy-vm.md` — this file only covers what is different
about THIS release. Read failure modes 1, 5, 6 and 7 there if you have not
deployed this agent before.

## What is in it

| Commit | Change | Needs |
|---|---|---|
| `1be1466` | SM-to-SM policy transfer (mapping `direction`) | new **app image** + **migration** |
| `45a05d1` | `BETTER_AUTH_URL` is an origin, not the auth mount path | **compose file** only — no image |

`reconciliation-ingest` is **unchanged**. Do not rebuild or reload it.

## The two things that will bite

### 1. There is no version of this release that works against the old schema

The app image and the database schema must move together, and neither order
survives on its own:

- **New app, old schema** — every correction insert names a `direction` column
  that does not exist. Not just transfers: Drizzle puts the column in the INSERT
  for *all four* categories, so AutoPay submissions fail too.
- **Old app, new schema** — the new `correction_direction_iff_mapping` CHECK
  requires a direction on every `MAPPING` row, and the old code never sets one.
  Mapping claims start failing while everything else keeps working.

So the sequence below stops the app, migrates, and starts the new image. The app
is down for the length of the migration. That is deliberate and it is the only
window in which nothing is half-wrong.

### 2. The migration backfills before it constrains, and the order is hand-written

`drizzle/0008_chief_mac_gargan.sql` runs three statements in this order:

```
ALTER TABLE ... ADD COLUMN "direction"          -- generated
UPDATE ... SET direction = 'CLAIM_IN' WHERE ... -- HAND-ADDED
ALTER TABLE ... ADD CONSTRAINT ... CHECK (...)  -- generated
```

The `UPDATE` is not something `drizzle-kit` produced. Postgres validates a CHECK
against existing rows at `ADD CONSTRAINT` time, so **on any database that has
ever taken a mapping correction, the generated order alone aborts the whole
migration.** If anyone regenerates this file, that line is lost and the deploy
fails at exactly this step.

Check what production is carrying before you start:

```sql
SELECT count(*) FROM correction_request WHERE category = 'MAPPING';
```

Non-zero means the backfill is load-bearing. Zero means you got lucky this time.

## Pre-flight

```bash
git fetch origin && git checkout main && git pull   # expect 45a05d1
git log --oneline -3
grep -c "SET \"direction\" = 'CLAIM_IN'" drizzle/0008_chief_mac_gargan.sql   # expect 1
```

If that grep returns 0, stop — the migration has been regenerated and the
backfill is gone. Restore it from `45a05d1` before continuing.

## Build (on a machine that can reach `cdn.sheetjs.com`)

Failure mode 1 in the base doc: the CDN is not on the VM's outbound whitelist, so
`npm ci` fails there. Build here, carry the image over.

```bash
podman build \
  --build-arg NEXT_PUBLIC_BASE_PATH=/reconciliation \
  -t localhost/reconciliation-app:latest .
podman save localhost/reconciliation-app:latest | gzip > reconciliation-app.tar.gz

# The one-shot migration runner — a named stage of the same Dockerfile.
podman build --target migrate -t localhost/reconciliation-migrate:latest .
podman save localhost/reconciliation-migrate:latest | gzip > reconciliation-migrate.tar.gz
```

`NEXT_PUBLIC_BASE_PATH` is a **build** arg. Next bakes `basePath` into every
emitted route and asset URL; setting it at runtime gives you a bundle whose links
point where nothing is served.

## On the VM

```bash
cd /opt/reconciliation-agent

# 1. Stop. Do this BEFORE migrating — see "the two things that will bite".
sudo podman-compose -f docker-compose.shared.yml down

# 2. Load the new images. Ingest is unchanged; do not reload it.
gunzip -c reconciliation-app.tar.gz     | sudo podman load
gunzip -c reconciliation-migrate.tar.gz | sudo podman load

# 3. Migrate. shared-postgres publishes no host port, so this runs INSIDE the
#    network. The image entrypoint is `npm run db:migrate && npm run db:custom`.
sudo podman run --rm --network shared-network \
  -e DATABASE_URL="postgresql://reconciliation_user:${RECONCILIATION_DB_PASSWORD}@shared-postgres:5432/reconciliation_db" \
  localhost/reconciliation-migrate:latest

#    Expect: "migrations applied successfully" then six "applied ...sql" lines,
#    the last being 0008_mapping_counterparty.sql.
#
#    If it fails with `check constraint "correction_direction_iff_mapping" is
#    violated by some row`, the backfill line is missing from 0008 — see
#    pre-flight. NOTHING has been half-applied; drizzle wraps each file.

# 4. The auth fix. This is a compose-file change, not an image change, so it
#    only lands if you re-copy the file.
sudo cp <repo>/docker-compose.shared.yml /opt/reconciliation-agent/
grep BETTER_AUTH_URL /opt/reconciliation-agent/docker-compose.shared.yml
#    Expect exactly: http://bajajlife-marketing-ai.bajajlifeinsurance.com
#    with NO /reconciliation and NO /api/auth on the end.

# 5. Start.
sudo podman-compose -f docker-compose.shared.yml up -d
```

### Also update the infra repo's copy

`docs/deploy-vm.md` records that `bajaj-ai-infra/bajaj-ai-platform/reconciliation-agent/`
holds a **copy** of `docker-compose.shared.yml`, and that `start-all.sh` iterates
`/opt/*/` to find compose files. If you fix `BETTER_AUTH_URL` only in
`/opt/reconciliation-agent/`, the next person who deploys from the infra repo
reintroduces the login bug. Change both.

## Verify

```bash
# The app is up and routed
curl -I http://10.3.5.99/reconciliation             # 200, not 301
curl    http://10.3.5.99/reconciliation/api/health  # ok

# Login actually works now — this is the auth fix, and it is the whole point.
# Expect a JSON body, NOT a 404.
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST http://10.3.5.99/reconciliation/api/auth/sign-in/email \
  -H 'Content-Type: application/json' -d '{"email":"x@y.z","password":"wrong"}'
#   401 or 400 = the router is mounted correctly (bad credentials, as asked)
#   404        = BETTER_AUTH_URL still carries a path. Step 4 did not land.

# Ingest is untouched and still healthy
sudo podman ps --filter name=reconciliation-ingest --format '{{.Names}} {{.Status}}'
```

Schema landed:

```sql
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'correction_request' AND column_name = 'direction';

SELECT conname FROM pg_constraint WHERE conname = 'correction_direction_iff_mapping';

SELECT indexname FROM pg_indexes WHERE indexname = 'correction_mapping_proposed_open';
```

All three must return a row. The third comes from `db:custom`, not from
`db:migrate` — if the first two exist and the third does not, `db:custom` did not
run and the counterparty list will work but scan sequentially.

Then, as a sales user: open a record you own → **Transfer to another SM** → the
form should open with the transfer direction preselected and accept a policy
number.

## Rolling back

The app image rolls back by reloading the previous tarball. **The schema does
not roll back**, and it does not need to: `direction` is nullable and the old
code never writes it, so the previous image runs fine against the new schema for
every category except `MAPPING` — where the CHECK will reject the old code's
direction-less inserts.

So if you roll the image back, mapping corrections stay broken until you either
roll forward again or drop the constraint:

```sql
ALTER TABLE correction_request DROP CONSTRAINT correction_direction_iff_mapping;
```

Leave the column and the backfilled data in place. Dropping the column would
discard which way every existing reassignment went, and nothing reconstructs it
— `sm_id` is the column those requests rewrite.
