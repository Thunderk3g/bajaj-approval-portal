# Verifier Layer, Monthly Cycle, and Shared-VM Deployment — Design Spec

**Date:** 2026-07-28
**Status:** Approved for planning
**Owner:** abhinav.chaturvedi@bajajlife.com
**Extends:** `2026-07-23-sales-disposition-reconciliation-portal-design.md`

---

## 1. Purpose

Three changes to the reconciliation portal, requested together on 2026-07-28.

1. **A verifier gate.** Today a salesperson's correction request goes straight to an
   approver. A fourth role — **Verifier** — is inserted between them. Nothing reaches an
   approver until a verifier has checked it.
2. **A monthly cycle.** The portal is a monthly tracker, but the data model has no notion of
   a month. Records accumulate across uploads with no way to say "this is July's workload",
   and nothing ever closes.
3. **Deployment onto the shared VM.** The portal runs only on a developer machine against a
   local Postgres. It needs to join the existing Bajaj AI Platform stack on 10.3.5.99.

Each is additive. No existing behaviour is removed.

## 2. Scope

### In scope

- A `verifier` role with its own dashboard, queue, request detail and history.
- A `VERIFIED` correction status, with the approval transaction re-gated onto it.
- A `period` table, period stamping on batches / records / requests, and a monthly close.
- Period-aware dashboards, filters and exports.
- A container image, a compose file joining `shared-network`, an nginx route, and a
  database on `shared-postgres`.

### Out of scope (deliberately)

Territory-scoped verifiers, per-category verification routing, a terminal reject at the
verifier stage, auto-expiry of stale requests, archival or purging of old records, TLS
termination, a scheduler or cron, and email notification. Each was considered and set aside
in §11.

## 3. The verifier layer

### 3.1 The flow

```
                       ┌───────────┐
    SM submits ───────►│  PENDING  │   verifier's queue
                       └─────┬─────┘
                   ┌─────────┴─────────┐
               verify                return
                   │                   │
                   ▼                   ▼
             ┌──────────┐        ┌──────────┐
             │ VERIFIED │        │ RETURNED │◄──────────┐
             └────┬─────┘        └────┬─────┘           │
        ┌─────────┼─────────┐         │ SM edits        │
    approve    reject    return       └──► PENDING      │
        │         │         │              (count++)   │
        ▼         ▼         └───────────────────────────┘
   ┌──────────┐ ┌──────────┐
   │ APPROVED │ │ REJECTED │   both terminal
   └──────────┘ └──────────┘
```

The verifier has exactly two decisions: **Verify** and **Return**. There is no terminal
reject at the verifier stage — a verifier's "no" sends the request back to the salesperson
with remarks, which is the answer the salesperson can actually act on. Only an approver can
kill a request outright.

Both stages return to the same `RETURNED` status, so the salesperson learns one return path
rather than two, and one resubmission button serves both. The event timeline distinguishes
them: the actor's role is on the `correction_event` row and rendered beside every entry.

`WITHDRAWN` is unchanged and still reachable only from `PENDING` or `RETURNED`.

### 3.2 Why the verifier cannot reject terminally

A terminal reject at the verifier stage would create a second way for a request to die
without an approver ever seeing it. That matters because the approver's history and the
export's `Decision` column are the record of what the review function decided; a request
killed before it reached them would be invisible in both, and the salesperson would have no
appeal short of raising a brand-new request that has lost its evidence and its conversation.

Returning costs nothing by comparison: the request stays alive on one timeline, and if the
salesperson genuinely has no case they withdraw it themselves — which is already recorded
as their own action rather than misattributed to a reviewer.

### 3.3 Two statuses that lock, three that don't

The partial unique index `correction_one_open_per_field` currently covers
`('PENDING','RETURNED')`. It **must** widen to `('PENDING','VERIFIED','RETURNED')`.

Without that, the window between "verifier passes it" and "approver decides it" is a window
in which the field looks free, and the salesperson can open a second competing request
against it. Two approvals would then race for the same column and one would be lost — the
exact failure the index exists to prevent, reintroduced by the new status.

This makes "which statuses lock the field" and "which statuses the submitter may still
withdraw" two different sets, where today one constant serves both:

| Concept | Statuses | Used by |
|---|---|---|
| `LOCKING_STATUSES` | `PENDING`, `VERIFIED`, `RETURNED` | the partial unique index |
| `WITHDRAWABLE_STATUSES` | `PENDING`, `RETURNED` | `withdrawCorrection` |

A verified request is deliberately **not** withdrawable. Someone has already spent review
effort on it, and letting the submitter discard that silently — after the verifier has
signed their name to it — turns a completed review into a dead end with no record of why.

### 3.4 Re-gating the approval transaction

`applyApprovalWithin` and `decideWithin` in `src/lib/approvals/apply.ts` both select
`WHERE status = 'PENDING' ... FOR UPDATE`. Both change to `'VERIFIED'`.

That single predicate is what makes the gate real rather than cosmetic. A Server Action is a
POST endpoint reachable without rendering any layout, so an approver who is handed a
`PENDING` request id — from a stale tab, a copied link, or a crafted request — hits the same
`NOT_PENDING` guard that already stops two approvers double-deciding, and the transaction
refuses. The gate lives in the same place the concurrency guarantee does.

The error message changes with it: "already decided by someone else" is wrong for a request
that has simply not been verified yet.

### 3.5 New columns

`correction_request` gains:

| Column | Type | Note |
|---|---|---|
| `verified_by` | `text → user.id` | Who verified |
| `verified_at` | `timestamptz` | When |
| `verifier_remarks` | `text` | What they checked, or what they asked for |

Kept separate from `reviewed_by` / `approver_remarks` rather than reusing them. The two
stages are answered by different people and both answers must survive: an export or an audit
that can only name one reviewer cannot say whether a bad correction got through because the
verifier missed it or because the approver overrode them.

On resubmission all six columns clear together — the row's review columns describe the
current review, and there is not one yet. The prior remarks are not lost; they live on the
`correction_event` rows, which is exactly why §5.8 of the base spec keeps a timeline.

### 3.6 Scoping and access

A verifier is a global reviewer, like an approver:

- `scopedRecordCondition` returns `undefined` for `verifier` — they see every record. A
  verifier who could only see part of the queue would leave the rest unverifiable by anyone.
- `/api/proofs/[attachmentId]` admits `verifier`. Verification without the proof is not
  verification.
- A verifier account carries **no** `SM_ID`, enforced by the existing "only a Sales account
  has an SM_ID" rule in `src/lib/users/schema.ts`.

### 3.7 Notifications

| Trigger | Recipients | Was |
|---|---|---|
| Submitted / resubmitted | all active **verifiers** | all active approvers |
| Verified | all active **approvers** | — |
| Returned by verifier | the submitting salesperson | — |
| Approved / rejected / returned by approver | the submitting salesperson | unchanged |
| Mapping claim approved | both reps | unchanged |

Two new notification types, `CORRECTION_VERIFIED` and `CORRECTION_RETURNED_BY_VERIFIER`.
The second is distinct from `CORRECTION_RETURNED` so the salesperson's inbox says who asked
and what stage it came back from — the fix differs depending on which.

If there is no active verifier account, a submission would notify nobody and sit invisibly.
`submitCorrection` therefore surfaces the count: a submission that reached zero verifiers is
recorded in the audit metadata and shown to the admin on the corrections screen, rather than
failing silently.

### 3.8 Routes

| Path | Purpose |
|---|---|
| `/verifier` | Dashboard: queue depth, ageing, throughput |
| `/verifier/queue` | Pending requests, oldest first |
| `/verifier/requests/[id]` | Comparison, proof, timeline, verify/return |
| `/verifier/history` | Past verifications |

`ROLE_PREFIXES` gains `verifier: '/verifier'`, which is the single source the navigation,
the middleware matcher, the post-login redirect and `roleForPath` all derive from.

## 4. The monthly cycle

### 4.1 A period is a calendar month

`period` rows are calendar months, keyed `YYYY-MM`. Not a rolling 30-day window: a rolling
window has no stable boundary, so two reports run a day apart cover different data and
"which month does this gap belong to" has no answer. A monthly tracker that cannot reconcile
against last month's copy of itself is not a tracker.

```
period
  id           uuid pk
  code         text unique          -- '2026-07'
  label        text                 -- 'Jul 2026'
  starts_on    date
  ends_on      date
  status       period_status        -- OPEN | CLOSED
  closed_by    text → user.id
  closed_at    timestamptz
  created_at   timestamptz
```

`label` is stored rather than derived so an export carries the same words the screen showed,
without a formatter in the reader's timezone deciding otherwise.

### 4.2 Exactly one open period

```sql
CREATE UNIQUE INDEX period_one_open ON period (status) WHERE status = 'OPEN';
```

Every `OPEN` row holds the same value in the indexed column, so a second one cannot be
inserted. "Which period are we in?" is then a question with one answer, enforced by the
database rather than by every caller remembering to check.

### 4.3 Where the period is stamped

| Table | Column | Set when | Meaning |
|---|---|---|---|
| `upload_batch` | `period_id` | at upload, confirmed before commit | which cycle this file is for |
| `sales_record` | `period_id` | on commit | the most recent cycle that carried this record |
| `correction_request` | `period_id` | at submission | the cycle the claim was raised in |

A record re-imported in the August file becomes August's workload. A record **absent** from
that file keeps its old period — which is precisely the "not in latest batch" state §6.8 of
the base spec already describes, now expressed as data instead of as an absence.

A request's period never changes after submission. If the record moves to a newer period
next month, the request still belongs to the cycle it was raised in; otherwise closing a
month would retroactively drag in work that was never part of it.

### 4.4 Closing

Two triggers, no scheduler:

- **Automatic.** Committing a batch into period P closes any `OPEN` period older than P.
  Uploading next month's file is what closes last month. This is the normal path and it
  requires nobody to remember anything.
- **Manual.** An admin closes the current period from `/admin/periods`.

The effect of `CLOSED`:

| Action against a closed period | Allowed |
|---|---|
| Raise a **new** correction request | **No** |
| Resubmit a `RETURNED` request | Yes |
| Verify, approve, reject, return | Yes |
| Withdraw | Yes |
| Read, filter, export | Yes |

Only the first is blocked. Blocking the rest would strand exactly the requests that were
mid-review when the month turned, which is the moment the queue is fullest.

Closing **warns** about open requests, listing them with their counts, and proceeds. It never
refuses: a close that can be blocked by one unreviewed request is a close that will not
happen, and the monthly upload would stall behind it.

The guard lives in `submitCorrection`, next to the scope check, and is re-asserted by a
database trigger on insert — the same belt-and-braces the base spec uses for the `Others`
description, and for the same reason: the application check is the explanation, the
constraint is the guarantee.

### 4.5 Where the period surfaces

- **Sales dashboard** — "Jul 2026: 6 records need attention", scoped to the open period.
- **Records browsing** — a period filter, defaulting to the open period for sales and to
  "all" for admin.
- **Verifier / approver queues** — a period column and filter; the queue itself stays
  unfiltered by default, because an unverified request from a closed month still needs
  deciding.
- **Export** — a period filter, a `Period` column on `Master Data`, and the period on
  `Export Info`.
- **`/admin/periods`** — the list, each period's record and correction counts, the close
  button, and a warning listing open requests before closing.

## 5. Deployment onto the shared VM

### 5.1 Placement

The Bajaj AI Platform runs one shared stack (`shared-postgres`, `shared-redis`,
`shared-nginx`) on RHEL 9 at 10.3.5.99 under Podman. `shared-nginx` is the only container
that binds a host port and routes to agents by path.

| Item | Value |
|---|---|
| Agent name | `reconciliation` |
| Nginx path | `/reconciliation/` |
| Container | `reconciliation-app:3008` |
| Database | `reconciliation_db`, owner `reconciliation_user` |
| Host ports | none |

Port 3008 is the next free frontend slot in `docs/port-registry.md` (3004 and 3006 are
reserved for hr and voice). One container, not two: this is a Next.js server that owns both
the UI and the Server Actions, so there is no separate backend to register. `monitoring-agent`
already sets the precedent for an agent that does not fill both columns.

`/reconciliation/` rather than `/sales/`: `basePath: '/sales'` would put the salesperson's
own dashboard at `/sales/sales`, and the platform path would collide with a role prefix
inside the app.

### 5.2 The nginx route

Copied from the compliance-agent pattern, which is the same shape — a Next.js app with a
`basePath` behind lazy hostname resolution:

```nginx
location = /reconciliation {                    # EXACT. A bare prefix location makes
    set $recon http://reconciliation-app:3008;  # nginx 301 to /reconciliation/, which
    proxy_pass $recon;                          # Next 308s back => redirect loop.
    client_max_body_size 64m;
    ...
}
location /reconciliation/ { ... }               # PREFIX, for /_next/* and everything else
```

No `rewrite` — with a variable `proxy_pass` and no URI part, nginx forwards `$uri`
unchanged, which is what `basePath` expects.

### 5.3 Four things that will silently break this

**`client_max_body_size 64m`.** nginx defaults to **1 MB**. The source workbook is 9.14 MB and
a correction carries up to five 10 MB proofs. Without this, every import and every proof
upload dies at the proxy with a 413 before Next sees it — and the application's own size
checks, which return a message naming the offending file, never run.

**Timeouts.** `proxy_params.conf` sets `proxy_read_timeout 60s`. Committing 1,171 rows plus
their version snapshots can exceed that. These blocks need 180s — and because re-declaring
`proxy_read_timeout` alongside the `include` is an nginx `[emerg]` that takes the whole
platform's config down, they must spell their proxy headers out instead of including
`proxy_params.conf`. `/seo/api/` already does exactly this for the same reason.

**Secure cookies over plain HTTP.** `src/lib/auth/server.ts` sets
`secure: NODE_ENV === 'production'`, and `shared-nginx` listens on `:80` only. The browser
accepts the session cookie and then never sends it back — an infinite login loop that
presents as "wrong password". A new `COOKIE_SECURE` env var, defaulting to `true`, is set
`false` on the VM.

This is a real weakening, not a config detail: session cookies will cross the corporate LAN
in clear text, and anyone on-path can replay one for the eight hours it lives. It is recorded
as a known gap in `docs/deploy-vm.md` with TLS termination at `shared-nginx` as the fix.
`shared/certs/` already exists for it.

**The SheetJS tarball.** `package.json` pins
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, and `cdn.sheetjs.com` is **not** on
the whitelist in `infra-access-request.md`. `npm install` fails on the VM behind the proxy.
The image is therefore built where the CDN is reachable and the built image moved to the VM,
or the tarball is vendored into the repo. `pull_policy: never` means the image must be
present locally anyway.

### 5.4 Storage

`storage/` — `uploads/`, `proofs/`, `exports/` — is a **named volume**, never container-local
disk. Proof attachments are customer documents and the uploaded workbooks are the evidence
that a record's original value was what it claims; losing them on the next rebuild would
break the base spec's guarantee that the original survives three independent ways.

### 5.5 Files

In this repository:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage, `node:20-slim`, `output: 'standalone'` |
| `docker-compose.shared.yml` | Joins `shared-network` external, named volume, no `ports:` |
| `deploy/nginx-reconciliation.conf` | The location blocks to paste into `shared/nginx.conf` |
| `docs/deploy-vm.md` | The runbook, including the known gaps above |
| `.dockerignore` | Keeps `storage/`, `node_modules`, `.next` out of the build context |

In `bajaj-ai-infra`: the nginx location blocks, a `reconciliation_db` entry in
`shared/init-db.sh`, and a row in `docs/port-registry.md`.

## 6. Data model changes

New enum `period_status` (`OPEN`, `CLOSED`).

Extended enums:

| Enum | Added |
|---|---|
| `role` | `verifier` |
| `correction_status` | `VERIFIED` |
| `event_action` | `VERIFIED` |

New audit actions: `CORRECTION_VERIFY`, `CORRECTION_RETURN_VERIFIER`, `PERIOD_OPEN`,
`PERIOD_CLOSE`.

New table `period` (§4.1). New columns: `correction_request.verified_by/verified_at/
verifier_remarks/period_id`, `upload_batch.period_id`, `sales_record.period_id`.

Custom SQL (drizzle-kit cannot express these):

- `correction_one_open_per_field` dropped and recreated including `VERIFIED`.
- `period_one_open` partial unique index.
- `correction_period_open` trigger — refuses an INSERT whose period is `CLOSED`.

Postgres cannot add an enum value and use it in the same transaction, so the enum additions
land in their own migration ahead of anything that references them.

## 7. Testing

**Unit** — the transition table (which status each role may act on), the locking-vs-
withdrawable status split, period code and label derivation, and the "is this period open"
predicate.

**Integration**, against `sales_portal_test`:

1. An approver cannot approve, reject or return a `PENDING` request — the transaction
   refuses and the record is unchanged. *This is the test that proves the gate.*
2. A verifier cannot approve — `requireRole('approver')` refuses.
3. Full path: submit → verify → approve, asserting the record updated exactly once, one
   version row, and both `verified_by` and `reviewed_by` populated with different users.
4. Verifier return → resubmit → verify → approve, asserting one request row throughout, the
   resubmission count, and a timeline carrying every transition.
5. While a request is `VERIFIED`, a second request against the same field is refused by the
   partial unique index.
6. A `VERIFIED` request cannot be withdrawn.
7. Two verifiers verifying the same request concurrently: one wins, one gets a clean
   domain error.
8. A closed period refuses a new request but permits resubmission, verification and
   approval of one already open.
9. Committing a batch into a newer period closes the older one, and only one `OPEN` period
   survives.
10. Notification fan-out: submitting reaches verifiers and not approvers; verifying reaches
    approvers.

The authorization negatives matter most. They are what fail loudly if a later refactor drops
the `VERIFIED` predicate and quietly re-opens the direct path from submission to approval.

## 8. Migration of existing data

Requests already `PENDING` when this ships are, under the new flow, awaiting verification —
which is correct. They appear in the verifier's queue and proceed normally. Nothing is
back-filled into `VERIFIED`: claiming a verifier checked something they never saw would be
a false entry in the very trail this feature exists to create.

Existing records, batches and requests get `period_id = NULL`. Null means "before the portal
tracked periods", and it is not an open period — so the close guard cannot block a
correction against a pre-period record. The first upload after this ships creates the first
period.

## 9. Build sequence

1. Enum additions (own migration), then the `period` table, the new columns, and the custom
   SQL.
2. RBAC, role prefixes, navigation, middleware matcher, proof access, user provisioning.
3. The verification service and the re-gated approval transaction, with notifications.
4. Period assignment on commit, close rules, `/admin/periods`.
5. The `/verifier` screens.
6. Export and dashboard period/verifier columns.
7. Tests across all of the above.
8. Dockerfile, compose, nginx, deploy runbook, infra-repo changes.

## 10. Assumptions

1. **"Every thirty days" means a calendar month.** Stated in §4.1.
2. **One verifier pool, all categories.** No territory scoping, no per-category routing.
3. **The VM stays on HTTP.** §5.3 records the consequence and the fix.
4. **Verifier accounts are created by an admin**, like every other account. No self-signup,
   no import-driven provisioning.

## 11. Rejected alternatives

**Terminal reject at the verifier stage.** §3.2.

**Territory-scoped verifiers.** Needs an assignment table kept in sync with the `Manpower`
roster, and a request whose territory has no verifier becomes unreviewable. Revisit when
there is more than one verifier and they disagree about who owns what.

**Per-category verification** (gate only `MAPPING` and `ISSUANCE_DATE`). Two code paths
through the same transaction, and the category that carries the most volume — `AUTOPAY`, 249
of the ISSUED gaps — would skip the check entirely, which is where wrong values would
actually accumulate.

**Auto-expiring stale requests after 30 days.** Queue hygiene, not a monthly cycle, and it
destroys the submitter's work on a timer nobody is watching. The period close already makes
staleness visible.

**Archiving records older than 30 days.** Directly contradicts §6.7 of the base spec, which
establishes that the master table accumulates so a rep can correct a months-old record. The
June data proves the case: the 292 rows of `Mapping Changes Latest` are all prior-month
applications.

**A cron job to close periods.** The platform has no scheduler, and adding one for a single
monthly transition means a new container, a new failure mode, and a close that happens when
nobody is looking. Closing on the next commit ties the transition to the act that actually
starts the new month.
