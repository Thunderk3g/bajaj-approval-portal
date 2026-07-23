# Sales Disposition Reconciliation Portal — Design Spec

**Date:** 2026-07-23
**Status:** Approved for planning
**Owner:** abhinav.chaturvedi@bajajlife.com

---

## 1. Purpose

Sales records exported from the core system arrive as an Excel workbook in which certain
add-on fields — AutoPay, Mapping, Issuance Date, and miscellaneous others — are frequently
blank or wrong. Today there is no controlled way to fix them: corrections happen over email
and in ad-hoc spreadsheet edits, leaving no evidence of who changed what, on whose authority,
or on what proof.

This portal replaces that with a closed loop:

1. An **Admin** imports the master workbook into the database.
2. A **Salesperson** sees only their own records, spots a wrong or missing field, proposes the
   correct value, and attaches proof.
3. An **Approver** compares the original value, the proposed value, and the proof, then
   approves, rejects, or returns the request with remarks.
4. On approval the master record is updated, the prior value is preserved as a version, and a
   fresh Excel file can be generated containing the approved corrections.

The uploaded workbook is never modified. It is stored immutably and every downstream change is
attributable.

## 2. Scope

### In scope

- Three roles with distinct dashboards: Admin, Sales, Approver.
- Excel import with admin-driven column mapping, validation, and duplicate `Apps_No` detection.
- Record browsing with search, filtering, and pagination; Sales scoped to their own `SM_ID`.
- Correction requests across four categories with mandatory proof attachments.
- Approval workflow with approve / reject / return-for-more-info, remarks, and resubmission.
- Full version history per record and an append-only audit log of every action.
- In-app notifications.
- Generation of a new Excel export carrying approved corrections plus a corrections log sheet.

### Out of scope (deliberately)

Email/SMTP notifications, SSO or Active Directory integration, mobile applications, real-time
websockets, multi-tenancy, bulk correction import, and OCR of proof documents. Each is a
plausible future addition; none is required to close the loop described above, and each would
add credentials or infrastructure that the current build does not need.

## 3. Technology

| Concern | Choice | Reason |
|---|---|---|
| Framework | Next.js, App Router | Server Actions keep mutations server-side; one deployable unit |
| Auth | Better Auth | Database-backed sessions, role support, no self-signup |
| Database | PostgreSQL 16 via Docker Compose | No credentials to source; `jsonb`, `numeric`, and partial indexes all used |
| ORM | Drizzle + drizzle-kit | Typed schema, parameterized SQL only, migrations in-repo |
| Excel | ExcelJS | Reads and writes `.xlsx`, supports cell fills and comments needed for the export |
| UI | Tailwind CSS + shadcn/ui | Accessible primitives; no design system to build from scratch |
| Validation | Zod | One schema shared by client hints and server enforcement |
| Tests | Vitest | Unit coverage of pure logic plus integration against a throwaway database |

**Money is `numeric(18,2)`, never a float.** APE and FRP are premium values; binary floating
point would introduce rounding drift across import, correction, and export.

## 4. Security model

### 4.1 Authorization is enforced at the data layer

Middleware redirects unauthenticated and wrongly-roled users, but middleware is **not** the
authorization boundary. Every Server Action and Route Handler independently calls
`requireRole(...)`, which re-reads the session and the user's current role from the database.
A middleware bypass, a stale cookie, or a directly-invoked action therefore still fails closed.

Sales scoping is likewise structural: all Sales-facing queries go through
`scopedRecordQuery(session)`, which appends `WHERE sm_id = $session.smId`. There is no code
path in which a Sales user's query is built without that predicate, so a tampered request
parameter cannot reach another representative's records.

### 4.2 Accounts

- No public sign-up. `emailAndPassword.disableSignUp = true`.
- The first Admin is created by `npm run setup:admin`, which refuses to run once any user exists.
- All subsequent users are created by an Admin, who assigns role and — for Sales — `SM_ID`.
- A database `CHECK` constraint enforces that `role = 'sales'` implies `sm_id IS NOT NULL`.
- Deactivation sets `is_active = false`; sessions are rejected on the next request. Users are
  never hard-deleted, because audit rows reference them.
- Login is rate-limited to 5 attempts per minute per IP.

### 4.3 Sessions

HTTP-only, `SameSite=Lax`, `Secure` in production. Eight-hour expiry with rolling refresh after
one hour of activity. Sessions are database-backed, so role changes and deactivations take
effect immediately rather than at token expiry.

### 4.4 Proof files

Proof attachments are the sensitive artefact in this system — they are customer documents.

- Written to `storage/proofs/YYYY/MM/<uuid>.<ext>`, **outside** `public/`. There is no static
  URL that reaches them.
- The stored filename is a generated UUID. No component of the path derives from user input,
  so path traversal has no surface.
- Served only by `GET /api/proofs/[attachmentId]`, which checks: session valid → user is Admin,
  or Approver, or the Sales user who submitted the parent request. Any other caller gets 404
  (not 403 — a 403 would confirm the attachment exists).
- Accepted types: `.jpg`, `.jpeg`, `.png`, `.webp`, `.pdf`. Both the extension **and** the
  leading magic bytes must match; a `.png` whose header says otherwise is rejected.
- Limits: 10 MB per file, 5 files per request.
- Responses carry `X-Content-Type-Options: nosniff` and a `Content-Security-Policy` of
  `default-src 'none'`, so a malicious upload cannot execute in the viewer's origin.
- Every view is written to the audit log.

### 4.5 Response headers

`Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy` denying camera,
microphone, and geolocation.

### 4.6 Audit log integrity

`audit_log` is append-only. A `BEFORE UPDATE OR DELETE` trigger raises an exception, so neither
application code nor a compromised session can rewrite history. Actor email and role are
denormalized onto each row, so the log stays readable even if the user record later changes.

## 5. Data model

Enumerated types: `role` (`admin`, `sales`, `approver`), `correction_status` (`PENDING`,
`APPROVED`, `REJECTED`, `RETURNED`), `correction_category` (`AUTOPAY`, `MAPPING`,
`ISSUANCE_DATE`, `OTHERS`), `batch_status` (`DRAFT`, `MAPPED`, `VALIDATED`, `COMMITTED`,
`FAILED`, `ABORTED`), `change_type` (`IMPORT`, `CORRECTION`, `REIMPORT`, `ADMIN_EDIT`),
`event_action` (`SUBMITTED`, `RESUBMITTED`, `APPROVED`, `REJECTED`, `RETURNED`, `WITHDRAWN`).

### 5.1 Auth tables

`user`, `session`, `account`, `verification` follow the Better Auth schema. `user` is extended
with `role`, `sm_id` (nullable), and `is_active`.

### 5.2 `upload_batch`

One row per uploaded workbook. Holds `original_file_name`, `stored_path`, `file_hash` (SHA-256,
used to warn on re-upload of an identical file), `sheet_name`, `header_row`, `column_mapping`
(jsonb, canonical field → source header), `date_format`, row counts (`total`, `valid`,
`invalid`, `duplicate`), `status`, `validation_report` (jsonb), and uploader/committer
identities and timestamps.

### 5.3 `upload_batch_row` — staging

Parsing writes here first; nothing touches the master table until the Admin commits. Each row
carries `row_number`, `raw` (source header → cell value as read), `normalized` (canonical field
→ normalized value), `issues` (jsonb array), `is_duplicate`, `duplicate_of_row`, and a status of
`VALID`, `INVALID`, `DUPLICATE`, `COMMITTED`, or `SKIPPED`.

This staging step is what makes the mapping screen possible: the Admin sees real parsed values
and a real error report before deciding to commit.

### 5.4 `sales_record` — current master state

Unique on `apps_no`. Columns: `sm_id`, `sm_name`, `policy_no`, `ape numeric(18,2)`,
`frp numeric(18,2)`, `autopay`, `mapping`, `issuance_date date`, `others`, plus `extra` (jsonb,
holding every source column that was not mapped to a canonical field), `source_batch_id`,
`source_row_number`, `current_version`, `has_corrections`, and timestamps.

Preserving unmapped columns in `extra` means no data is lost on import even when the incoming
workbook carries columns this spec did not anticipate, and those values remain searchable.

Indexes: unique on `apps_no`; btree on `sm_id`, `policy_no`, `issuance_date`; GIN trigram
(`pg_trgm`) on `apps_no`, `policy_no`, and `sm_name` for substring search; GIN on `extra`.

### 5.5 `sales_record_version` — history

A full jsonb snapshot per change, unique on `(record_id, version)`. Version 1 is always the
untouched imported row. Each row records `change_type`, `changed_fields text[]`, `changed_by`,
`changed_at`, and the originating `correction_request_id` or `batch_id`.

The original value therefore survives three independent ways: the uploaded file on disk,
version 1 of the record, and the `original_value` snapshot on the correction request.

### 5.6 `correction_request`

`record_id`, `apps_no` (denormalized for display and search), `category`, `field_name`,
`field_label`, `original_value`, `proposed_value`, `description`, `submitted_by`, `sm_id`,
`submitted_at`, `status`, `reviewed_by`, `reviewed_at`, `approver_remarks`, `applied_at`,
`applied_version`, `resubmission_count`, `last_resubmitted_at`.

Two constraints carry business rules into the database:

- `CHECK (category <> 'OTHERS' OR description IS NOT NULL AND length(trim(description)) > 0)` —
  the "Others" category cannot be submitted without a description.
- A partial unique index on `(record_id, field_name) WHERE status IN ('PENDING','RETURNED')` —
  the same field cannot have two open requests competing to change it.

### 5.7 `correction_attachment`

`request_id`, `stored_path`, `original_name`, `mime_type`, `size_bytes`, `sha256`,
`uploaded_by`, `uploaded_at`.

### 5.8 `correction_event` — approval history

Every transition: `request_id`, `action`, `actor_id`, `from_status`, `to_status`, `remarks`,
`created_at`. This is what renders the request timeline, and it survives resubmission cycles
that would otherwise overwrite the single-status field.

### 5.9 `audit_log`

`actor_id`, `actor_email`, `actor_role`, `action`, `entity_type`, `entity_id`, `before` (jsonb),
`after` (jsonb), `metadata`, `ip_address`, `user_agent`, `created_at`. Append-only per §4.6.

Actions recorded: `AUTH_LOGIN`, `AUTH_LOGIN_FAILED`, `AUTH_LOGOUT`, `USER_CREATE`,
`USER_UPDATE`, `USER_DEACTIVATE`, `UPLOAD_CREATE`, `UPLOAD_MAPPING_SET`, `UPLOAD_VALIDATE`,
`UPLOAD_COMMIT`, `UPLOAD_ABORT`, `UPLOAD_ORIGINAL_DOWNLOAD`, `RECORD_UPDATE`,
`RECORD_CONFLICT_RESOLVE`, `CORRECTION_SUBMIT`, `CORRECTION_RESUBMIT`, `CORRECTION_APPROVE`,
`CORRECTION_REJECT`, `CORRECTION_RETURN`, `CORRECTION_WITHDRAW`, `ATTACHMENT_UPLOAD`,
`ATTACHMENT_VIEW`, `EXPORT_GENERATE`, `EXPORT_DOWNLOAD`.

### 5.10 `notification` and `excel_export`

`notification`: `user_id`, `type`, `title`, `body`, `link`, `is_read`, `read_at`, `created_at`,
indexed on `(user_id, is_read, created_at DESC)`.

`excel_export`: `requested_by`, `file_name`, `stored_path`, `sha256`, `row_count`,
`correction_count`, `filters` (jsonb), `created_at`, `download_count`.

## 6. Import pipeline

Import is two-phase because column names in the source workbook cannot be assumed. Nothing is
hardcoded to a header spelling; the Admin confirms the mapping and sees the consequences before
committing.

```
Upload .xlsx ─► store file + hash ─► parse headers & rows into staging
     └─► auto-suggest mapping (fuzzy match vs canonical fields)
           └─► ADMIN CONFIRMS MAPPING  ◄── human gate
                 └─► validate + normalize + detect duplicates
                       └─► show error report
                             └─► ADMIN COMMITS  ◄── human gate
                                   └─► upsert sales_record + write version rows
```

### 6.1 Canonical fields

`Apps_No`, `SM_ID`, `SM_Name`, `Policy_No`, `APE`, `FRP`, `AutoPay`, `Mapping`,
`Issuance_Date`, `Others`. Auto-suggestion normalizes candidate headers (lowercase, strip
non-alphanumerics) and scores them against each canonical field's alias list, e.g. `Apps_No`
matches `application no`, `app number`, `appno`. The Admin can override every suggestion, and
can mark a column as unmapped — unmapped columns land in `extra`, not the bin.

### 6.2 Normalization

| Field | Rule |
|---|---|
| All strings | Trim; collapse internal whitespace |
| `Apps_No` | Required; uppercase; spaces stripped. Empty is an ERROR. A value not matching `^[A-Z0-9/-]{3,50}$` is a WARNING, not a rejection |
| `SM_ID` | Required; uppercase; trimmed. Empty is an ERROR |
| `APE`, `FRP` | Strip currency symbols, commas, spaces; parse to `numeric(18,2)`. Blank → NULL. Negative → ERROR. Unparseable → ERROR |
| `Issuance_Date` | Accept Excel serial numbers, native dates, and `dd/MM/yyyy`, `dd-MM-yyyy`, `yyyy-MM-dd`, `MM/dd/yyyy`. **Default interpretation is `dd/MM/yyyy`** (Indian convention), selectable per batch on the mapping screen. Outside 1990-01-01 … today + 1 year → WARNING |
| `AutoPay` | `Y`/`YES`/`TRUE`/`1`/`ACTIVE` → `Yes`; `N`/`NO`/`FALSE`/`0`/`INACTIVE` → `No`; blank → NULL; anything else → WARNING, raw value retained |
| `Mapping`, `Others` | Free text, trimmed |

Ambiguous dates are the one place where silent guessing would corrupt data invisibly —
`03/04/2026` is either 3 April or 4 March. Hence the explicit per-batch format selector rather
than heuristic detection.

### 6.3 Severity model

**ERROR** blocks a row from being committed. **WARNING** allows commit and is surfaced in the
report and on the record. The Admin can commit a batch containing warnings; rows with errors
are skipped and listed with their row numbers, so nothing fails silently.

### 6.4 Duplicate `Apps_No`

Duplicates are detected on normalized `Apps_No` both **within** the incoming batch and
**against** existing master records. Within-batch duplicates are flagged with a pointer to the
first occurrence; the first occurrence is treated as authoritative and later ones are marked
`DUPLICATE` and excluded from commit unless the Admin explicitly selects one. Duplicates are
never silently dropped — the count appears on the batch summary and the rows are listed.

### 6.5 Re-import conflict policy

When a batch contains an `Apps_No` that already exists:

- Fields with **no** approved correction are updated from the file.
- Fields carrying an **approved correction are not overwritten.** The differing incoming value
  is recorded as a `CONFLICT` in the validation report and shown on the batch review screen.
  The Admin may explicitly accept the file value per conflict, which writes a `REIMPORT` version
  and an audit entry.
- New `Apps_No` values are inserted.
- Existing records absent from the new file are left untouched and flagged "not in latest
  batch". Records are never deleted by an import.

Silently reverting an approved, evidenced correction because someone re-uploaded a stale export
is the most damaging failure this system could have. The default therefore protects approved
work and escalates the conflict to a human.

## 7. Correction workflow

```
                    ┌──────────────┐
   Sales submits ──►│   PENDING    │
                    └──────┬───────┘
             ┌────────────┼────────────┐
        approve        reject        return
             │            │            │
             ▼            ▼            ▼
        ┌─────────┐  ┌──────────┐  ┌──────────┐
        │APPROVED │  │ REJECTED │  │ RETURNED │
        └─────────┘  └──────────┘  └────┬─────┘
         (terminal)   (terminal)        │ Sales edits
                                        └──► PENDING (resubmission_count++)
```

`RETURNED` exists so an Approver can ask for a clearer proof or a corrected value without
destroying the request and its history. Resubmission reuses the same request row and appends a
`RESUBMITTED` event, so the whole conversation stays on one timeline.

A Sales user may withdraw their own request while it is `PENDING` or `RETURNED`.

### 7.1 Categories

`AutoPay`, `Mapping`, and `Issuance Date` map to a fixed canonical field. `Others` requires the
salesperson to name the field and supply a description; a Zod discriminated union enforces this
on the server and the `CHECK` constraint of §5.6 enforces it in the database. Client-side
requiredness is a convenience, never the control.

At least one attachment is required to submit.

### 7.2 Applying an approval

A single database transaction:

1. Re-read the record `FOR UPDATE` and re-verify the request is still `PENDING`.
2. Write a new `sales_record_version` snapshot of the **pre-change** state.
3. Update the target field on `sales_record`; bump `current_version`; set `has_corrections`.
4. Set the request to `APPROVED` with `reviewed_by`, `reviewed_at`, `approver_remarks`,
   `applied_at`, `applied_version`.
5. Insert the `correction_event`.
6. Insert the `audit_log` row with before/after.
7. Insert the notification for the submitter.

Any failure rolls the whole thing back. The `FOR UPDATE` re-check is what prevents two
approvers acting on the same request concurrently from producing two versions and one lost
update.

## 8. Excel export

Generates a **new** workbook; the original upload is never opened for writing.

- **Sheet `Master Data`** — canonical columns in the mapped source order, plus preserved `extra`
  columns, plus `Corrected_Fields`, `Correction_Count`, and `Last_Corrected_On`. Cells holding an
  approved correction get a highlight fill and a cell comment carrying the original value, the
  approver, and the approval date.
- **Sheet `Corrections Log`** — one row per applied correction: `Apps_No`, field, original value,
  approved value, category, description, submitter, `SM_ID`, submitted date, approver, decision,
  remarks, decision date.
- **Sheet `Export Info`** — generated by and at, filters applied, source batch, and counts.

Filename `sales-reconciliation-<YYYYMMDD-HHmm>-v<n>.xlsx`, stored under `storage/exports/` and
recorded in `excel_export`. Exports are filterable by batch, `SM_ID`, date range, and
"corrected records only".

## 9. Routes

| Path | Role | Purpose |
|---|---|---|
| `/login` | public | Sign in. No self-registration |
| `/setup` | public, first-run only | Create the first Admin; 404s once a user exists |
| `/admin` | admin | Dashboard: records, batches, pending queue depth, duplicates, recent activity |
| `/admin/uploads`, `/uploads/new`, `/uploads/[id]` | admin | Upload, map columns, review validation, commit |
| `/admin/records`, `/records/[appsNo]` | admin | Browse all records; detail with version history |
| `/admin/corrections` | admin | All requests, any status |
| `/admin/exports` | admin | Generate and download Excel outputs |
| `/admin/audit` | admin | Filterable audit log |
| `/admin/users` | admin | Create users, assign role and `SM_ID`, deactivate |
| `/sales` | sales | Dashboard: my records, my pending / approved / rejected / returned |
| `/sales/records`, `/records/[appsNo]` | sales | Own records only; flags missing fields |
| `/sales/requests`, `/requests/new`, `/requests/[id]` | sales | Submit, track, resubmit |
| `/approver` | approver | Dashboard: queue depth, ageing, throughput |
| `/approver/queue`, `/approver/requests/[id]` | approver | Review with side-by-side comparison and proof preview |
| `/approver/history` | approver | Past decisions |

Route Handlers: `/api/auth/[...all]`, `/api/proofs/[attachmentId]`,
`/api/exports/[id]/download`, `/api/uploads/[id]/original`, `/api/notifications`. All mutations
are Server Actions.

### 9.1 Search, filtering, pagination

Search spans `Apps_No`, `Policy_No`, `SM_Name`, and the preserved `extra` columns — so a
customer name or mobile column present in the source workbook becomes searchable without a
schema change. Trigram indexes back substring matching. Filters: batch, `SM_ID` (Admin only),
issuance date range, AutoPay present/absent, has-corrections, and correction status.
Pagination is offset-based with a total count and a page-size selector, defaulting to 25 —
keyset pagination does not combine cleanly with arbitrary sort columns and trigram relevance
ordering, and the record volumes here do not justify the complexity.

## 10. Notifications

| Trigger | Recipients |
|---|---|
| Correction submitted or resubmitted | All active Approvers |
| Approved, rejected, or returned | The submitting salesperson |
| Batch committed | Sales users whose `SM_ID` appears in that batch |
| Export generated | The requesting Admin |

Delivered in-app via a bell with unread count, polled on an interval. Notifications link
directly to the relevant request or record.

## 11. Testing

**Unit (Vitest)** — the pure logic that carries the risk: header fuzzy-matching, value
normalization (`AutoPay` vocabulary, currency stripping, all date formats including Excel
serials), duplicate detection, severity classification, the correction Zod schemas including
the `Others` branch, and Excel export construction.

**Integration (Vitest against a `sales_portal_test` database)** — batch commit including the
re-import conflict policy; the approval transaction including the concurrent-approval race;
and authorization negative tests that assert a Sales user cannot read another `SM_ID`'s records
or fetch another user's proof attachment. The authorization tests matter most: they are the
ones that fail loudly if a future refactor drops a scoping predicate.

## 12. Local setup

```
docker compose up -d      # PostgreSQL 16 on :5432
npm install
npm run db:migrate
npm run setup:admin       # interactive; refuses once any user exists
npm run dev
```

`storage/` is git-ignored and holds `uploads/`, `proofs/`, and `exports/`. In a server
deployment it is a mounted volume, not container-local disk.

## 13. Pending inputs from the master workbook

The user is supplying the real Excel file. The design does not block on it — column mapping is
an admin-driven runtime step, header spellings are not hardcoded, and unmapped columns are
preserved in `extra`. On receipt, these are confirmed and the alias lists and defaults tuned:

1. Exact header spellings, sheet name, and header row index.
2. Whether a customer name / mobile / email column exists. If so it is promoted from `extra` to
   a first-class indexed column, since the requirement calls for searching by customer details.
3. The date format actually used in `Issuance_Date`, to set the per-batch default.
4. The real value vocabulary in `AutoPay` and `Mapping`.
5. Whether `Apps_No` is in fact unique in production data, and what a legitimate duplicate means
   if it is not.
6. What `Mapping` and `Others` contain semantically, which determines the field labels shown to
   salespeople.

## 14. Build sequence

1. Scaffold, Docker Compose, Drizzle schema, Better Auth, RBAC helpers, app shell.
2. Import pipeline: parse → map → validate → stage → commit.
3. Record browsing: search, filters, pagination, Sales scoping, detail with version history.
4. Correction submission: forms, category branching, attachment upload, secure proof serving.
5. Approver queue: comparison view, proof preview, decisions, the apply transaction.
6. Notifications and the audit log viewer.
7. Excel export.
8. Dashboards, then the test suite across all of the above.
