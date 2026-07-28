# Ingestion Service — Design Spec

**Date:** 2026-07-28
**Status:** Approved for planning
**Owner:** abhinav.chaturvedi@bajajlife.com
**Extends:** `2026-07-23-sales-disposition-reconciliation-portal-design.md`,
`2026-07-28-verifier-and-monthly-cycle-design.md`

---

## 1. Why

Uploading the real workbook appeared to hang. It did not: the upload itself
finished in 4.8 s and the **review page** took 74.6 s, measured from the dev
server log.

```
POST /admin/uploads/new          200 in   4,767ms
GET  /admin/uploads/<id>         200 in  74,623ms
```

The page calls `listSheets()` and then `readSheet()`, each of which is a full
`XLSX.read` of a 9.14 MB `.xlsb`. SheetJS already receives every optimisation
available to it — `sheetRows: 1` on the listing, a `sheets: [name]` allowlist on
the read — and still costs ~37 s per pass, because it decompresses and walks the
entire container to locate sheet boundaries. Two passes, 74.6 s, synchronously
inside a page render.

Measured against the same file on the same machine:

| Operation | Node / SheetJS | Python / calamine |
|---|---|---|
| Open + list 10 sheet names | ~37 s | **0.00 s** |
| Read `Login Data` (1,172 × 36) | second ~37 s pass | **0.33 s** |
| `Manpower` (187) + `Mapping Changes` (293) | included above | **0.00 s** |
| **Total for what the importer needs** | **74.6 s** | **0.33 s** |

Roughly 225×. calamine opens the container lazily; SheetJS does not.

Two things this is **not**:

- **Not Drizzle.** Drizzle is the Postgres query builder and never touches a
  workbook. Replacing it would not move this number by a millisecond.
- **Not the container boundary.** The same parse in another process takes the
  same time. Moving work across a network without changing *how* it is done
  makes it slower, not faster.

What genuinely justifies a separate service is three things: the parsing library
is faster in Python by two orders of magnitude, long work belongs outside a
request/response cycle, and proof documents are PDFs — which Python handles well
and Node does not.

## 2. The 28 GB row

`Lead Dump` declares a range of 54,508 × 16,383 ≈ 893 million cells. Calling
calamine's `to_python()` on it attempts a ~28 GB allocation and dies.

The file is 9.14 MB. The data is not large — the **declared range** is. Streaming
the sheet row by row and trimming trailing blanks reveals the truth:

```
trimmed row widths: [(15, 54506), (0, 5493), (16383, 1)]
```

**One row** carries formatting out to column 16,383. Every other populated row is
**15 columns wide**. That single row inflates the declared range, and any reader
that materialises the declared range — in any language — dies on it.

**The rule this imposes on the service: never materialise a declared range.
Stream, trim trailing blanks per row, and derive the used width from the data.**

## 3. What the service owns, and what it does not

`reconciliation-ingest` is deliberately narrow. It is a **parsing and staging**
service, not a second application.

| Concern | Owner | Why |
|---|---|---|
| Workbook parsing, Lead Dump streaming | **ingest** | 225× faster, and the streaming discipline lives in one place |
| Staging rows, normalization, gap detection | **ingest** | Same pass as parsing; a second hop would re-read the file |
| Lead attribution to SMs | **ingest** | Derived during the same stream |
| Proof/PDF processing (future) | **ingest** | The reason Python is worth having |
| Authentication, sessions, RBAC | **Next.js** | Better Auth owns it, it is tested, and splitting an auth boundary across two services is how you get two answers to "who is this" |
| The correction workflow and the verifier gate | **Next.js** | Built and covered by 637 tests. Moving it would be a rewrite with no benefit |
| Approval transaction, period close | **Next.js** | They are database transactions against tables the app already owns |
| All UI | **Next.js** | |

**The verifier → approver flow does not move.** It already works exactly as
required: an SM raises a request, a verifier checks it, only then can an approver
apply it. That is enforced by a single `FOR UPDATE ... WHERE status = 'VERIFIED'`
predicate and covered by tests that fail loudly if it is ever dropped. Rewriting
it in Python would discard that for nothing.

## 4. Boundary

One shared Postgres, two writers, disjoint tables.

```
Browser ──► Next.js ──► Postgres        auth, records, corrections, periods
               │            ▲
               │ POST /jobs │  ingest writes: ingest_job, upload_batch_row, lead
               ▼            │
          reconciliation-ingest ──► reads the stored workbook from the shared volume
```

- The two services **do not share an ORM**. Drizzle stays in Next.js; the service
  uses SQLAlchemy Core against the same tables. Sharing a schema definition across
  two languages means generating one from the other, and a generator is a third
  thing to keep correct.
- **Drizzle migrations remain the single source of truth for schema.** The service
  never runs DDL. If its SQLAlchemy table definitions drift from the real schema,
  a startup check fails loudly rather than the service writing to a column that
  is not there.
- The service **never authenticates a human**. It is called only by Next.js, over
  the internal network, with a shared secret in `X-Ingest-Token`. It has no
  session concept and no user-facing route.

## 5. The job contract

Upload stops being synchronous. This is the change that fixes the perceived hang,
and it would be needed even if parsing were instant, because committing 1,171
records plus version rows is not.

```
POST /jobs/parse      { batch_id, stored_path, sheet_name?, header_row? }  -> { job_id }
GET  /jobs/{job_id}                                                        -> { status, progress, result?, error? }
POST /jobs/leads      { batch_id, stored_path }                            -> { job_id }
GET  /health                                                               -> { status, database }
```

`status` is one of `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`. `progress` is
`{ stage, done, total }` so the UI can say "reading Lead Dump, 32,000 of 54,507"
rather than spinning.

Jobs are rows in `ingest_job`, not in-memory futures: a service restart mid-parse
must leave a job visibly `FAILED`, not silently lost. A job whose row says
`RUNNING` with no heartbeat for 5 minutes is reaped to `FAILED` on startup.

## 6. Lead Dump and SM attribution

### 6.1 The columns that matter

Streaming the sheet yields 15 columns, of which these carry the attribution:

| idx | Header | Populated | Meaning |
|---|---|---|---|
| 0 | `LEAD_NO` | 54,507 | The lead's identifier — the natural key |
| 3 | `TL_NAME` | 54,507 | Team leader |
| 4/5 | `Location` ×2 | 54,507 | Duplicated header; disambiguated by index |
| 7 | `Register Date` | 54,507 | Excel serial (46174 → 2026-06-01) |
| 10 | `SM Name` | 54,507 | Rep name |
| **11** | **`SM_CODE`** | **54,507** | **The attribution key** |
| 12/13 | `CCM` / `CCM Code` | 54,507 | Channel manager |
| 1/2/6/8/9/14 | product and source fields | varies | Retained, not attributed on |

`SM_CODE` is the same identifier family as `sales_record.sm_id` — `ICCS427343`
and `C2CM24850` against the master's `ICCSP90766` and `C2CM21350` — so it
attributes directly, subject to the same uppercasing the master already applies.
Six reps in the June data appear in both cases; without normalising, each would
see a partial view of their own leads.

### 6.2 `lead` table

Unique on `lead_no`. Carries `sm_code`, `sm_name`, `tl_name`, `ccm`, `ccm_code`,
`location`, `register_date`, `source`, `product_type`, `product_mix`,
`saving_flag`, plus `extra` jsonb for anything else the sheet holds, and
`source_batch_id` / `period_id` matching the master table's conventions.

Attribution is a **column, not a join through a name**: `sm_code` is stored
normalised and indexed, and a Sales user's lead list is
`WHERE sm_code = $session.smId` — structurally identical to how
`scopedRecordCondition` already scopes records, so a rep cannot see another rep's
leads by tampering with a parameter.

### 6.3 Leads do not join to records

`Lead Dump` has no `Apps_No`. It cannot be joined to `sales_record`, and the base
spec deferred it for exactly that reason. That has not changed — what has changed
is that a rep should still *see their own leads*, which needs no join at all.

Leads are therefore a **parallel, read-only view scoped by SM_CODE**. They are
not correctable, do not enter the verifier queue, and do not participate in the
monthly close. Inventing a synthetic link between a lead and an application would
be a claim the data does not support.

### 6.4 Orphan codes

An `SM_CODE` with no `manpower` roster row is flagged `is_orphan`, exactly as
`flagOrphans` already does for transaction data. The rep keeps their leads; the
admin sees a list to reconcile. Dropping the row instead would hide real leads
from a real person because a roster sheet was stale.

## 7. Failure behaviour

- **The service is down.** Upload refuses with a message naming the service,
  rather than accepting a file it cannot process. A workbook accepted and then
  silently unparsed is worse than a refusal.
- **A job fails.** The batch stays `DRAFT`, the stored file is retained, and the
  error text is shown on the review page. Nothing is written to `sales_record`.
- **A job is orphaned by a restart.** Reaped to `FAILED` on next startup.
- **Schema drift.** Startup validates that every column the service writes exists
  in the database, and refuses to start otherwise.

## 8. Security

- The service binds no host port and is reachable only on `shared-network`.
- Every request carries `X-Ingest-Token`, compared in constant time. A missing or
  wrong token is 404, not 401 — the service does not confirm its own existence to
  an unauthenticated caller.
- It reads the workbook from the shared storage volume by the path Next.js
  recorded; that path is validated against the storage root exactly as
  `resolveStoredPath` does, so a tampered path cannot escape it.
- It never returns file contents, only parsed summaries and counts.
- No customer data is logged. Row-level errors reference row numbers, not values.

## 9. Testing

**Python (pytest)** — the streaming reader against a fixture cut from the real
workbook, including the 16,383-column rogue row; trailing-blank trimming; the
duplicate `Location` header; `SM_CODE` normalisation; Excel serial dates;
orphan detection; and a fixture asserting the parse never allocates the declared
range.

**Integration** — the job lifecycle including the reap-on-restart path, and the
refusal when the service is unreachable.

**Existing 637 tests stay green.** The Next.js side keeps its behaviour; only the
transport under `createUploadBatchAction` changes.

## 10. Rejected alternatives

**Rewrite the whole backend in Python.** The correction workflow, the verifier
gate and the approval transaction are 637 passing tests' worth of behaviour whose
value is entirely in being correct. Rewriting them buys nothing and risks the one
invariant that matters — that no correction reaches an approver unverified.

**Replace Drizzle.** Unrelated to the problem, as measured in §1.

**Keep parsing in Node but move it to a worker.** Fixes the blocking, keeps the
37 s. Worth doing if Python were unavailable; it is not.

**Cache the parse result in Next.js.** Removes the doubling — 74.6 s to 37 s. A
real improvement over nothing, and still an unacceptable wait.
