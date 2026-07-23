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
| Excel read | SheetJS (`xlsx` 0.20.3, official CDN tarball) | The source file is `.xlsb`, which ExcelJS cannot read at all |
| Excel write | ExcelJS | Cell fills and comments needed by the export; SheetJS CE does not write them |
| UI | Tailwind CSS + shadcn/ui | Accessible primitives; no design system to build from scratch |
| Validation | Zod | One schema shared by client hints and server enforcement |
| Tests | Vitest | Unit coverage of pure logic plus integration against a throwaway database |

**Money is `numeric(18,2)`, never a float.** ANP and FP are premium values; binary floating
point would introduce rounding drift across import, correction, and export. The source data
already contains fractional premiums (e.g. `FP = 4195.42`), so this is not hypothetical.

**Two Excel libraries is a deliberate split, not redundancy.** The source workbook is `.xlsb`
(Excel Binary), a format ExcelJS does not support in any version. SheetJS reads it; ExcelJS
writes the styled export. Neither library alone covers both ends.

`npm install https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` — the official SheetJS
distribution, not the abandoned `xlsx` package on the public npm registry, whose last published
version (0.18.5) carries unpatched prototype-pollution and ReDoS advisories.

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

Unique on `apps_no`. First-class columns, named after the real source headers:

| Group | Columns |
|---|---|
| Identity | `apps_no` (text), `policy_no` (text), `client_name`, `lead_id` |
| Attribution | `sm_id`, `sm_name`, `tl_id`, `tl_name`, `ccm_id`, `ccm_name`, `location` |
| Dates | `login_date date`, `issued_date date` |
| Money | `fp numeric(18,2)`, `anp numeric(18,2)` |
| Product | `product_name`, `product_type`, `product_variant`, `booking_frequency`, `pay_mode` |
| Status | `status`, `status_2`, `autopay` |

Plus `extra` (jsonb, every source column not mapped to a first-class field — `FY`,
`Login_Month`, `Issued_Month`, `Login Week`, `Source`, `RECEIPT_NO`, `Product_Code`, `PPT`,
`BT`, `WROP`, `BASBA`, `LA Occupation`, `IP_GENDER`), `source_batch_id`, `source_row_number`,
`current_version`, `has_corrections`, and timestamps.

`apps_no` and `policy_no` are **text**, not numeric, even though the source stores them as
numbers. They are identifiers, never arithmetic operands; storing them as text prevents both
scientific-notation formatting (the source workbook already displays `5.92E+09` in places) and
any future precision loss if identifier length grows.

Preserving unmapped columns in `extra` means no data is lost on import even when a later
workbook carries columns this spec did not anticipate, and those values remain searchable.

Indexes: unique on `apps_no`; btree on `sm_id`, `policy_no`, `issued_date`, `status`; GIN
trigram (`pg_trgm`) on `apps_no`, `policy_no`, `client_name`, and `sm_name` for substring
search; GIN on `extra`.

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
Upload .xlsb/.xlsx ─► store file + hash ─► pick sheet ─► parse rows into staging
     └─► auto-suggest mapping (fuzzy match vs canonical fields)
           └─► ADMIN CONFIRMS MAPPING  ◄── human gate
                 └─► validate + normalize + detect duplicates
                       └─► show error report
                             └─► ADMIN COMMITS  ◄── human gate
                                   └─► upsert sales_record + write version rows
```

### 6.1 Sheet selection

The source is a 10-sheet dashboard workbook, not a flat extract. The Admin picks the sheet;
`Login Data` is the transaction sheet and the default suggestion. Sheet choice matters for
performance as well as correctness: parsing all 10 sheets takes **37 s**, while parsing only
`Login Data` and `Manpower` takes **2.7 s**, because `Lead Dump` alone holds 54,508 rows and
16,383 columns of mostly-empty formatting. Import therefore passes an explicit sheet allowlist
to SheetJS rather than reading the whole workbook.

Header row is configurable per batch and defaults to 1. This is not theoretical: `Login Data`
has headers on row 1, but `SM Summary` has totals on row 1 and headers on row 2.

The mapping UI must tolerate malformed header rows — `Lead Dump` has two columns both titled
`Location` and trailing untitled columns. Blank headers are shown as `(column N)` and duplicate
headers are disambiguated by index, so neither silently collides.

### 6.2 Canonical fields

The original requirement named ten fields. Four do not exist under those names in the real
workbook, and the mapping below is the correction:

| Requirement | Actual source column | Note |
|---|---|---|
| `Apps_No` | `Apps_No` | Stored numeric, 10 digits |
| `SM_ID` | `SM_ID` | |
| `SM_Name` | `SM_Name` | |
| `Policy_No` | `Policy_No` | Stored numeric |
| `APE` | **`ANP`** | Annualised New Premium |
| `FRP` | **`FP`** | First Premium. `ANP = FP × frequency multiplier`, verified exact (12 for Monthly, 1 for Annual) |
| `AutoPay` | `AutoPay` | |
| `Issuance_Date` | **`Issued_Date`** | Excel serial numbers |
| `Mapping` | **no such column** | See §6.6 — it is SM attribution, held in a separate sheet |
| `Others` | **no such column** | Correct as-is: a catch-all correction category, not a field |

Auto-suggestion normalizes candidate headers (lowercase, strip non-alphanumerics) and scores
them against each canonical field's alias list — so `ANP` resolves to APE, `FP` to FRP, and
`Issued_Date` to issuance date without the Admin having to know the rename. Every suggestion is
overridable, and a column can be left unmapped, in which case it lands in `extra`, not the bin.

### 6.3 Normalization

**The `-` sentinel is the single most important rule here.** The source workbook uses a literal
hyphen, not an empty cell, to mean "no value": 86% of `Source`, 100% of `BASBA`, `LA
Occupation` and `IP_GENDER`, and 29% of `AutoPay` are `-`. Treating `-` as data would make gap
detection useless, because the fields most in need of reconciliation would all read as
populated. Normalization maps `-`, `NA`, `N/A`, `NULL`, `#N/A` and empty to NULL, for every
column.

| Field | Rule |
|---|---|
| All strings | Trim; collapse internal whitespace; sentinel values above → NULL |
| `Apps_No` | Required. Read as a **raw number, converted to an integer string** — never via display text, which yields `5.92E+09`. Empty is an ERROR. Observed: 10 digits, all numeric |
| `SM_ID` | Required; **uppercased**; trimmed. Empty is an ERROR |
| `Policy_No` | Raw number → integer string. NULL when absent |
| `ANP` (APE), `FP` (FRP) | Strip currency symbols, commas, spaces; parse to `numeric(18,2)`. Blank → NULL. Negative → ERROR. Unparseable → ERROR |
| `Issued_Date`, `Login_Date` | Accept Excel serial numbers (the observed form), native dates, and `dd/MM/yyyy`, `dd-MM-yyyy`, `yyyy-MM-dd`, `MM/dd/yyyy`. **Default interpretation `dd/MM/yyyy`**, selectable per batch. Serials convert on the 1900 system with the Lotus leap-year offset. Outside 1990-01-01 … today + 1 year → WARNING |
| `AutoPay` | `Y`/`YES`/`TRUE`/`1`/`ACTIVE` → `Yes`; `N`/`NO`/`FALSE`/`0`/`INACTIVE` → `No`; sentinel or blank → NULL; anything else → WARNING, raw retained |
| `Status`, `Status 2` | Uppercased, trimmed |

Uppercasing `SM_ID` is not cosmetic. The file contains 164 distinct `SM_ID` values that collapse
to **158** once uppercased — six reps appear in both cases (`c2cm21350` and `C2CM21350`).
Without normalization those six would each see a partial view of their own book, with the
remainder invisible and unfixable.

Ambiguous dates are the other place where silent guessing corrupts data invisibly —
`03/04/2026` is either 3 April or 4 March. Hence the explicit per-batch format selector rather
than heuristic detection.

### 6.4 Gap detection is status-conditional

A blank field is not automatically a defect, and the data proves it:

| Status | Rows | No `Issued_Date` | No `Policy_No` | No `AutoPay` |
|---|---|---|---|---|
| ISSUED | 839 | **0** | **3** | **249** |
| PENDING | 174 | 105 | 105 | 113 |
| REJECTED | 158 | 0 | 0 | 84 |

Every blank `Issued_Date` in the file belongs to a PENDING application — which is correct, not
broken: an unissued policy has no issuance date. A naive "field is empty" rule would raise 105
false reconciliation tasks and 108 more for `Policy_No`, burying the real work.

Gap rules:

- `Issued_Date` and `Policy_No` are flagged missing **only when `Status = ISSUED`.**
- `AutoPay` is flagged missing **only when `Status = ISSUED`**, since AutoPay on a rejected or
  pending application is not actionable.
- Everything else is informational, shown but not counted as a gap.

Applying these rules to the June file yields **250 ISSUED rows with at least one genuine gap,
spread across 100 of 158 reps** — a median of 6 rows per rep, maximum 30. That is the actual
workload the portal exists to clear, and it comfortably fits the default page size of 25.

The three ISSUED rows with no `Policy_No` are true anomalies and should surface at the top of
the Admin dashboard.

### 6.5 Severity model

**ERROR** blocks a row from being committed. **WARNING** allows commit and is surfaced in the
report and on the record. The Admin can commit a batch containing warnings; rows with errors
are skipped and listed with their row numbers, so nothing fails silently.

### 6.6 Duplicate `Apps_No`

Duplicates are detected on normalized `Apps_No` both **within** the incoming batch and
**against** existing master records. Within-batch duplicates are flagged with a pointer to the
first occurrence; the first occurrence is treated as authoritative and later ones are marked
`DUPLICATE` and excluded from commit unless the Admin explicitly selects one. Duplicates are
never silently dropped — the count appears on the batch summary and the rows are listed.

In the June file `Apps_No` is **1,171 distinct across 1,171 rows — no duplicates at all.** The
detection stays, because the risk is not within one month's extract but across the monthly
re-uploads the master table accumulates (§6.7), where the same application legitimately reappears.

### 6.7 `Mapping` means SM attribution

**Confirmed by the requester, 2026-07-23:** "Mapping" means *which `SM_ID` / `SM_Name` is
assigned to which `Apps_No`.*

There is no `Mapping` column. The workbook instead carries a separate sheet, `Mapping Changes
Latest`, holding 292 rows of exactly two columns: `App Number` → `SM ID`. A mapping issue is
therefore **an application credited to the wrong salesperson**, and a mapping correction
reassigns `sm_id` and `sm_name` together — they are never allowed to diverge, so approval
resolves the new `sm_name` from the `Manpower` roster rather than trusting free text.

Those 292 applications have **zero overlap** with the 1,171 in `Login Data` — the app-number
ranges differ by a full 200 million (5.91bn vs 6.16bn), meaning they are prior-month
applications. Two consequences:

1. The master table **accumulates across monthly uploads**; it is not scoped to one batch. A rep
   must be able to raise a correction against a record imported months earlier.
2. `Mapping Changes Latest` is imported as an optional secondary sheet, creating pre-approved
   mapping corrections attributed to the Admin who uploaded them, so existing reassignments
   carry into the system with provenance rather than being retyped.

### 6.8 Re-import conflict policy

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

| Category | Target field | Notes |
|---|---|---|
| `AUTOPAY` | `autopay` | `Yes` / `No`; the dominant workload at 249 ISSUED gaps |
| `MAPPING` | `sm_id` (+ `sm_name`) | Reassigns the sale to a different rep — see §7.2 |
| `ISSUANCE_DATE` | `issued_date` | Date picker, bounded to the batch's plausible range |
| `OTHERS` | rep names the field | Field name **and** description both required |

`Others` requiredness is enforced by a Zod discriminated union on the server and by the `CHECK`
constraint of §5.6 in the database. Client-side requiredness is a convenience, never the control.

At least one attachment is required to submit.

### 7.2 Mapping claims: the scoping exception

Mapping corrections break the rule that a Sales user only sees their own `SM_ID`. A rep whose
sale was credited to someone else cannot see that record — so under strict scoping they could
never raise the very claim the category exists for. This is the one place where the security
model and the business requirement genuinely conflict, and it needs an explicit, narrow
exception rather than an accidental one.

The exception:

- A Sales user may perform an **exact-match `Apps_No` lookup** across all records. Nothing else —
  no wildcards, no partial match, no browsing, no listing, no filtering by another `SM_ID`.
- The result is a **restricted projection**: `Apps_No`, `Client_Name`, `Product_Name`,
  `Status`, `Issued_Date`, and the current owner's `SM_Name`. No premium figures, no policy
  number, no contact fields, no attachments.
- Rate-limited to 20 lookups per user per hour, so the endpoint cannot be walked to enumerate
  the book. `Apps_No` is a 10-digit space and enumeration would be infeasible anyway, but the
  limit makes intent visible in the audit log.
- Every lookup writes an audit row, whether or not it matched.

Enumeration by lookup is the threat here, and the restricted projection plus rate limit is what
makes the exception safe to grant.

On approval of a mapping claim the record moves to the claimant's `SM_ID`, and `sm_name` is
resolved from the `Manpower` roster to match. Both the losing and gaining rep are notified,
since the record silently vanishing from one rep's list would otherwise look like data loss.
The approver sees both reps' identities side by side before deciding.

The losing rep is **notified, not consulted** — the approver decides. Adding a contest state
would deadlock reconciliation whenever a rep ignores the prompt. If the losing rep disagrees
they raise their own mapping claim, which follows the same path. The full history of every
reassignment stays on the record's version chain, so a disputed sale can always be traced.

### 7.3 Applying an approval

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

Search spans `Apps_No`, `Policy_No`, `Client_Name`, `SM_Name`, and the preserved `extra`
columns, all backed by trigram indexes for substring matching. `Client_Name` is the "customer
details" axis the requirement asked for; it is fully populated in the source. Filters: batch,
`SM_ID` (Admin only), `Status`, issued-date range, gap type (missing AutoPay / issuance date /
policy number, per the status-conditional rules of §6.4), has-corrections, and correction status.
Pagination is offset-based with a total count and a page-size selector, defaulting to 25 —
keyset pagination does not combine cleanly with arbitrary sort columns and trigram relevance
ordering, and the record volumes here do not justify the complexity.

## 10. Notifications

| Trigger | Recipients |
|---|---|
| Correction submitted or resubmitted | All active Approvers |
| Approved, rejected, or returned | The submitting salesperson |
| Mapping claim approved | **Both** the gaining and the losing rep (§7.2) |
| Batch committed | Sales users whose `SM_ID` appears in that batch, with their gap count |
| Export generated | The requesting Admin |

Delivered in-app via a bell with unread count, polled on an interval. Notifications link
directly to the relevant request or record.

## 11. Testing

**Unit (Vitest)** — the pure logic that carries the risk: header fuzzy-matching (including the
`ANP`→APE and `FP`→FRP renames), the `-` sentinel normalization, `SM_ID` uppercasing,
`Apps_No` numeric-to-string conversion (asserting no scientific notation), `AutoPay`
vocabulary, currency stripping, Excel serial-date conversion, status-conditional gap detection
against the §6.4 table, duplicate detection, severity classification, the correction Zod
schemas including the `Others` branch, and Excel export construction.

A trimmed `.xlsb` fixture cut from the real workbook — a few hundred rows preserving the
sentinel values, mixed-case `SM_ID`s, serial dates, and all three `Status` values — is
committed as the parser test input. The status-conditional gap tests assert the exact counts
from §6.4, so a regression that reintroduces naive blank-checking fails loudly rather than
quietly flooding the queue.

**Integration (Vitest against a `sales_portal_test` database)** — batch commit including the
re-import conflict policy; the approval transaction including the concurrent-approval race;
and authorization negative tests that assert a Sales user cannot read another `SM_ID`'s records
or fetch another user's proof attachment. The authorization tests matter most: they are the
ones that fail loudly if a future refactor drops a scoping predicate.

## 12. Local setup

```
docker compose up -d      # PostgreSQL 16 on :5432
npm install               # includes the SheetJS CDN tarball pinned in package.json
npm run db:migrate
npm run setup:admin       # interactive; refuses once any user exists
npm run dev
```

The SheetJS dependency resolves to `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, so
`npm install` requires network access to that host on first run. This is worth knowing before
deploying behind a restrictive proxy; the tarball can be vendored into the repo if outbound
access is not available.

`storage/` is git-ignored and holds `uploads/`, `proofs/`, and `exports/`. In a server
deployment it is a mounted volume, not container-local disk.

## 13. Source data profile

Measured from `Businesses Dashboard Jun'26.xlsb` (9.14 MB, 10 sheets) on 2026-07-23. Every
question left open in the first draft is now answered from the file itself.

### 13.1 Sheets

| Sheet | Rows | Role |
|---|---|---|
| `Login Data` | 1,171 × 36 | **The master transaction sheet.** Headers row 1 |
| `Manpower` | 186 × 7 | Rep roster: `SM_ID`, `SM_Name`, TL, CCM, Location. 180 distinct IDs — the source for provisioning Sales accounts |
| `Mapping Changes Latest` | 292 × 2 | Prior reassignments, `App Number` → `SM ID` |
| `Product Details` | 46 × 3 | Product code → name → type lookup |
| `SM Summary` | 237 × 6 | Per-rep aggregates. **Headers on row 2**, totals on row 1 |
| `Lead Dump` | 54,508 × 16,383 | Lead-stage data. Duplicate `Location` headers; mostly empty formatting |
| `Jan Target`, `BFL & BAU`, `Overall Dashboard`, `Dash` | — | Presentation sheets, not imported |

### 13.2 Confirmed facts

1. **`Apps_No` is unique** — 1,171 distinct across 1,171 rows, numeric, 10 digits. Duplicate
   detection is retained for cross-month accumulation, not within-file collisions.
2. **`Client_Name` exists and is 100% populated**, answering the "search by customer details"
   requirement. Promoted to a first-class, trigram-indexed column.
3. **Dates are Excel serial numbers.** `Issued_Date` spans 46176–46211 → 2026-06-03 to
   2026-07-08. `Login_Date` likewise.
4. **`AutoPay` has no `No` value.** Only `Y` (725), `-` (339), and empty (107). The field is
   effectively "confirmed" or "unknown", which is precisely why 38% of it needs reconciling.
5. **`Status` has three values:** ISSUED 839, PENDING 174, REJECTED 158. `Status 2` has 14 and
   is the granular sub-disposition (`FR-AR`, `PSTPNE6`, `DECLINED`, `C_OFFER`, …).
6. **158 distinct reps** after uppercasing (164 before). Median 6 rows per rep, max 30.
7. **7 `SM_ID`s in `Login Data` have no `Manpower` roster entry**, including one purely numeric
   ID (`512454`). Account provisioning must handle orphan IDs rather than assuming the roster is
   complete — an orphan gets an account on first appearance, flagged for Admin review.
8. **`ANP = FP × frequency multiplier`**, exactly (×12 Monthly, ×1 Annual). Useful as a
   validation warning: a row whose ANP/FP ratio contradicts its `Booking_Frequency` is
   suspicious and worth surfacing, though not an error.

### 13.3 Deferred

`Lead Dump` (54,508 rows) is not imported in this build. It is lead-stage data with no
`Apps_No`, so it cannot join to the master records and serves no reconciliation purpose today.
Importing it would multiply the data volume forty-fold for no current benefit.

## 14. Build sequence

1. Scaffold, Docker Compose, Drizzle schema, Better Auth, RBAC helpers, app shell.
2. Import pipeline: parse → map → validate → stage → commit.
3. Record browsing: search, filters, pagination, Sales scoping, detail with version history.
4. Correction submission: forms, category branching, attachment upload, secure proof serving.
5. Approver queue: comparison view, proof preview, decisions, the apply transaction.
6. Notifications and the audit log viewer.
7. Excel export.
8. Dashboards, then the test suite across all of the above.
