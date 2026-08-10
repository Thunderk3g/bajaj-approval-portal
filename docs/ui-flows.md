# UI / UX flows

Written to be handed to a UI generator or a designer. Every screen that exists
today is listed with what it is for, what it shows, what a user can do on it, and
which states it has to render. Screens the 2026-08-06 approval-workflow design
adds are marked **NEW** and described the same way, so a redesign can cover the
whole surface in one pass rather than discovering half of it later.

Nothing here is aspirational except the sections marked NEW. The rest describes
the application as it currently behaves.

---

## 1. Shape of the product

A reconciliation portal for life-insurance sales data. An administrator imports a
monthly workbook; sales managers see their own records and raise correction
requests against them; those requests climb an approval chain; approved
corrections rewrite the record and are versioned.

Six roles, each with its own URL space and its own sidebar. A user has exactly
one role.

| Role | Prefix | One-line purpose |
|---|---|---|
| `admin` | `/admin` | Imports workbooks, manages accounts, periods, chains, exports |
| `sales` | `/sales` | Sees their own records and leads, raises corrections |
| `verifier` | `/verifier` | First review of a submitted correction |
| `approver` | `/approver` | Final decision; applies the correction to the record |
| `tl` **NEW** | `/tl` | Team leader — signs off their reps' mapping changes, raises on their behalf |
| `acm` **NEW** | `/acm` | Area manager — signs off mapping changes across their teams |

### Vocabulary the UI must use consistently

- **Apps_No** — application number, the natural key of a record. Never rendered
  as a number; it is an identifier and can look like `59L0000000`.
- **SM_ID** — the sales manager's code, always uppercase. Scopes what a rep sees.
- **TL / ACM** — the two manager rungs. "ACM" is the label; the data column
  behind it is `ccm_id`. Show the label, never the column name.
- **Record** — one row of the business dashboard, one policy application.
- **Correction request** — a proposed change to one field of one record.
- **Batch / upload** — one imported workbook.
- **Period** — one calendar month of reconciliation. Exactly one is open.
- **Chain / stage** — the ordered list of approvals a request must clear.

---

## 2. Existing design system

Already implemented in `src/components/ui`. A redesign should either keep these
names or provide a mapping, because every screen is built from them.

**Layout** — `PageHeader` (title, description, actions slot), `Card` (title,
description, body), `Table` / `Th` / `Td`, `DetailRow` (label + value pair),
`Pagination`.

**Feedback** — `Alert` (tones: info, warning, danger, success), `EmptyState`
(title + description), `StatCard` (label, value, hint), `Badge` and
`StatusBadge` (tones: neutral, info, warning, danger, success), `Spinner`.

**Forms** — `Field` (label, hint, error, required marker), `Input`, `Textarea`,
`Select`, `Button` (variants: primary, secondary, danger, ghost), `LinkButton`.

**Loading** — every list and detail screen has a skeleton: `SkeletonPageHeader`,
`SkeletonStatCards`, `SkeletonTable`, `SkeletonDetailRows`, `SkeletonFields`,
`LoadingScreen`.

**Universal chrome** — sidebar (role's nav), notification bell with unread count
(polls `/api/notifications`), user menu with sign-out.

### States every screen must handle

1. **Loading** — skeleton, never a bare spinner on a full page.
2. **Empty** — `EmptyState` explaining what would put data here and what to do.
3. **Error** — `Alert` with a sentence the user can act on. Never a raw code.
4. **Forbidden** — `/forbidden`, reached when a role opens another role's page.
5. **Stale / conflict** — a decision somebody else already made. Explains who
   moved it and what to do (usually: reload).

---

## 3. Entry and identity

### `/login`
Public. Email + password. Errors are deliberately vague on credentials
("wrong email or password") but specific on everything else (account
deactivated, rate limited). On success, redirects to `?next=` if it is a safe
same-origin path, else the role's dashboard.

### `/setup`
Public, first run only. 404s the moment any user exists. Creates the first
administrator: full name, email, password (min 12). This is the only
unauthenticated write in the product.

### `/forbidden`
Reached when a signed-in user opens a path belonging to another role. Should say
which role they are and link to their own dashboard.

---

## 4. Admin

### `/admin` — dashboard
Stat cards: total records, open corrections, pending verification, duplicates,
records not in the latest batch. Recent activity list. Links into each area.

### `/admin/uploads` — batch list
Table: file name, uploaded by, uploaded at, status badge
(`DRAFT / MAPPED / VALIDATED / COMMITTED / FAILED / ABORTED`), row counts,
period code. Primary action: **New upload**.

### `/admin/uploads/new` — upload a workbook
Single file input (`.xlsb .xlsx .xlsm .xls`), optional notes. Warns on an
identical file hash ("you have uploaded this exact file before"). Up to 64 MB.
On success goes to the batch detail.

**NEW — the Manpower sheet is compulsory, and it comes first.**

This is a hard rule, not a suggestion, and the UI has to make the order obvious
*before* a file is chosen rather than explaining a failure afterwards.

**The rule.** A business dashboard cannot be committed unless a usable roster
already exists, **or** the same workbook carries a Manpower sheet that will
create one. A transaction sheet with no roster anywhere is refused at commit,
with the batch left validated so the admin can import a roster and press Commit
again — no re-upload.

**Why, stated on screen.** The Manpower sheet is the only thing that places a rep
under a team leader and that team leader under an area manager. Import the
dashboard first and every SM_ID becomes a rep the system knows by code and
nothing else: mapping corrections skip their TL and ACM steps because there is
nobody to route to, so they are approved by fewer people than the business asked
for, and nothing says so.

**Users come only from the roster.** A business dashboard never creates accounts.
Provisioning refuses any SM code the roster does not carry — the rep is listed as
refused and appears on `/admin/hierarchy` for an administrator, rather than
getting a login whose approval path is quietly shorter.

**What the screen shows:**

- **No roster yet** — a warning panel: *Import a Manpower sheet first*, with the
  reason above, and the note that a workbook containing both sheets does both in
  one pass.
- **Roster present** — a success panel: *the roster places N reps under a team
  leader and area manager, so a business dashboard imported now will map its
  SM_IDs against them*, plus a count of any SM_IDs seen in transaction data but
  absent from the roster, linking to Hierarchy.

**Creating logins from the roster.** After a Manpower import, the admin can
provision every new SM/TL/ACM code the sheet introduced. Passwords are generated,
shown once in a table, and downloadable as CSV — this screen is the only place
they are ever visible. Provisioning is roster-driven for managers (a TL needs an
account the moment the roster names them as an approver, which is before any
request reaches them).

**What committing a dashboard then does with the roster:** every imported record
carries its SM_ID, and the roster is what resolves that to a TL and an ACM at
approval time. The commit also records any SM_ID it saw that the roster does not
know, as an orphan, so the gap is visible rather than inferred.

### `/admin/uploads/[id]` — batch detail and commit
The longest flow in the product. Four phases on one page, each a `Card`:

1. **Sheet & header** — pick the sheet, the header row, the date format. Shows a
   preview of the first rows.
2. **Column mapping** — every source column against a canonical field, with a
   confidence hint and a "why" for each suggestion. Unmapped columns are
   preserved verbatim and shown as such.
3. **Validation** — counts of valid / invalid / duplicate rows, an issue list
   grouped by severity, per-row drill-down.
4. **Commit** — refuses if required fields are unmapped or the period is closed.
   Shows what will change: new records, updated records, roster rows, orphan
   SM_IDs discovered.

Parse runs asynchronously; the page polls `/api/ingest/jobs/[jobId]` and shows a
progress bar with the current stage in words. Also: **Download original**.

### `/admin/records` and `/admin/records/[appsNo]`
Search and filter across every record. Detail shows every canonical field, the
`extra` columns preserved from the source, full version history with a diff per
version, and any correction requests against it.

### `/admin/corrections`
Every correction request in the system, filterable by status, category, SM_ID,
period. Read-only oversight — an admin does not decide requests.

### `/admin/leads`
The Lead Dump view: leads by SM code, unassigned pool, orphan codes.

### `/admin/users`
Table: name, email, role badge, scope code, active flag, created. Actions:
create user, edit (name, role, scope), deactivate.

**NEW — hierarchy on the create/edit form.**

The account form shows exactly one scope field, the one that role reads, and the
others are *absent* rather than disabled — a code on the wrong field is the
subtler failure than a missing one, because the row looks scoped without being
scoped.

| Role chosen | Field shown | What it is |
|---|---|---|
| Sales | **SM_ID** | scopes them to their own records |
| Team leader | **TL code** | resolves their reps and their approval steps |
| Area manager | **ACM code** | the CCM code the sheet carries — ACM and CCM are one rung |
| Admin / verifier / approver | none | these read everything |

**The placement is read from the roster, never typed.** When an SM_ID is
prefilled, the form shows where the roster already puts that rep — `503576 →
TL001 → CCM001` — as an info panel, or a warning when it places them under
nobody. The person creating the account sees the approval chain their new user
will actually get, before saving.

This is deliberately *not* a pair of pickers the admin fills in. The roster is
the single source of that relationship; a hand-typed placement that disagrees
with it produces a login whose approval steps route somewhere the data does not
agree with, and there would then be two answers to "who is this rep's TL". To
change a placement, an administrator overrides the roster row on
`/admin/hierarchy`, which is recorded, survives later imports, and is visible as
drift against the sheet.

**The hierarchy table itself** lives on `/admin/hierarchy`: every rep with their
TL and ACM, which of those came from the sheet and which from an override, and
the two kinds of gap — reps placed under nobody, and manager codes with no
account. A TL's own view of the same tree is `/tl/team`; an ACM sees every team
beneath them at `/acm/team`, including which TL each rep sits under.

**NEW — bulk delete.** A checkbox column, a header select-all, and a
**Delete selected** action. It must:

- Say exactly how many accounts, and name any that cannot be deleted.
- Refuse, with a reason, any account that has audit history — those are
  deactivated instead, because the audit trail's actor is a restricted foreign
  key and deleting the row would either fail or orphan the trail.
- Offer **Deactivate selected** as the always-safe alternative in the same
  dialog, and default to it.
- Require typing the count to confirm a delete over ~10 accounts.

### `/admin/periods`
List of reconciliation months with status. Open one, close one. Closing warns
how many requests are still in flight and does not block on them.

### `/admin/exports`
Generate a filtered Excel export; list of past exports with row/correction
counts and a download link. Filters include an option to reproduce the uploaded
sheet's own layout with corrected cells highlighted.

### `/admin/audit`
Filterable append-only log: actor, action, entity, before/after, timestamp, IP.

### `/admin/workflows` **NEW** — approval chains
List of the eight chains (AutoPay, three Mapping variants, Issuance date, BAU to
BFL, Others, Agent ID). Per row: the stage sequence rendered as chips
(`TL → ACM → V2 → APPROVER`), whether it is active, when it last changed, and how
many requests are currently running it.

### `/admin/workflows/[chainKey]` **NEW** — edit one chain
- An ordered list of stages. Each row: stage name, who resolves it (a role, or
  "the TL of the submitter"), whether it may reject, and move-up / move-down /
  remove controls.
- **Add stage**: pick a resolver (a role pool, or a hierarchy rung), name it, and
  for a hierarchy rung on a mapping chain, pick which side it applies to —
  the submitter's team or the counterparty's.
- An informational banner: *N requests are currently running this chain and will
  finish on it unchanged; edits apply to new requests only.* This is a
  reassurance, never a block.
- **Preview**: enter an Apps_No (or two SM_IDs) and see the chain resolved to
  real names, with any rung that resolves to nobody flagged amber.
- History links to the audit log filtered to this chain.

### `/admin/hierarchy` **NEW** — the roster tree
- A worklist at the top: reps the roster places nowhere, and TL/ACM codes the
  roster names that have no account. Each row has a one-click "fix" that
  prefills the relevant form.
- The main table: SM_ID, name, TL, ACM, location, and a provenance badge —
  **sheet** or **overridden by X on date**.
- A **drift** badge when the latest sheet disagrees with an admin override, with
  one-click *accept the sheet* / *keep my override*.
- Inline edit per row to reassign a rep's TL or ACM, showing how many in-flight
  requests currently sit with the person being replaced.

---

## 5. Sales

### `/sales` — dashboard
Stat cards: my records, my open requests, approved, returned (needs my
attention). Returned requests are the call to action.

### `/sales/records`, `/sales/records/[appsNo]`
Only this rep's SM_ID. Detail flags missing or suspicious fields and offers
**Raise a correction** per field.

### `/sales/requests/new` — raise a correction
1. Find the record by Apps_No (typeahead, scoped to the rep).
2. Pick a category: AutoPay, Mapping, Issuance date, Agent ID, BAU to BFL, Other.
3. The form adapts: Mapping asks the direction (claim a sale in / transfer one
   out) and the counterparty SM_ID; Other asks which field.
4. Show current value beside proposed value, always.
5. Attach up to five proof documents (10 MB each).
6. Describe the reason — required for Other.

**NEW** — after picking the category, show the chain the request will climb, as
chips, so the rep knows before submitting that a mapping change needs their TL
and two ACMs.

### `/sales/requests`, `/sales/requests/[id]`
List with status badges. Detail shows the full timeline (submitted → each stage →
decided), every remark, the proofs, and — when RETURNED — a resubmit form
prefilled with the previous values.

**NEW** — the timeline becomes a stepper showing every rung of the chain, which
are done, which is current, and who each is waiting on.

### `/sales/leads`
The rep's own leads, read-only.

---

## 6. Verifier and approver

Both are queue-driven and structurally identical; they differ in what they may do.

### `/verifier` and `/approver` — dashboards
Queue depth, ageing (oldest waiting), throughput this period.

### `/verifier/queue`, `/approver/queue`
Table of requests awaiting this actor: Apps_No, rep, category, field,
old → new, age, proof count. Bulk select with a bulk decide action.

### `/verifier/requests/[id]`, `/approver/requests/[id]` — the decision screen
The most important screen in the product. Regions:

1. **Header** — Apps_No, category, status, who raised it and when.
2. **The change** — current value and proposed value side by side, large. A
   drift warning if the record has changed since the request was raised.
3. **Record context** — enough of the record to judge the claim.
4. **Proofs** — thumbnails, click to open; images inline, documents download.
5. **Timeline** — every prior stage with actor and remarks.
6. **Decision** — Approve / Verify, Return (remarks required), Reject (approver
   only, remarks required). Remarks are required on anything that sends the
   request back, because the rep has to know what to change.

**NEW** — this screen is shared by the TL and ACM rungs too. What changes per
actor is only which buttons appear; the layout does not fork.

### `/verifier/history`, `/approver/history`
Past decisions by this actor.

---

## 7. TL and ACM **NEW**

Two roles, one set of screens. A team leader and an area manager do the same job
at different widths — review what has reached them, look at who reports to them —
so the screens are shared and only the wording differs.

### Who they are

- A **TL** is a real login carrying a **TL code** from the Manpower sheet. Their
  team is every rep whose effective `tl_id` is that code.
- An **ACM** is a real login carrying an **ACM (CCM) code**. Their teams are every
  rep whose effective `ccm_id` is that code — usually several TLs' worth.
- "Effective" means the roster **with any admin override applied**. A manager
  sees the reps they are actually answerable for, not the ones a stale sheet says.
- Neither is a global role. A TL sees only their own reps' records; an ACM only
  theirs. This is narrower than a verifier, who sees everything.

### `/tl` and `/acm` — dashboard

Four stat cards:

| Card | Meaning |
|---|---|
| **Waiting on me** | Requests whose current step resolved to *this person* |
| **My team / My teams** | How many reps sit beneath them |
| **Open in team** | Requests their reps have raised and not yet had decided |
| **Without a login** | Reps on their roster with no portal account — an admin fix |

When anything is waiting, a panel links straight into the queue. The empty state
matters here: a manager who has nothing to do should see that plainly, not an
empty table they have to interpret.

### `/tl/queue`, `/acm/queue` — my approvals

Only requests whose **current** step is assigned to this person. Columns:
application, rep (SM_ID), the change as `old → new`, the step badge showing
`ACM · 2 of 4`, when it was raised, and a link to review.

This is a **named-person queue**, not a pool: a request appears for exactly one
manager, because the step was resolved and pinned to them when it opened. Two
TLs never see the same item.

Empty state: *"Nothing is waiting on you — when one of your reps raises a
correction that needs your sign-off, it appears here."*

### `/tl/requests/[id]`, `/acm/requests/[id]` — the decision

The **same decision screen** the verifier and approver use. Nothing forks; what
changes per actor is only which buttons appear. A manager in the middle of a
chain can **pass** or **send back**, never reject outright — rejection belongs to
the final step alone.

### `/tl/team`, `/acm/team`

Everyone beneath them: SM_ID, name, location, record count, open request count,
and whether they have a login. The ACM's table carries an extra **Team leader**
column, because their view spans several teams and "which TL is this rep under"
is the question that view exists to answer.

Empty state names the cause precisely: *"The Manpower sheet is what places a rep
under a manager. Until an administrator imports one that names your code, this
list stays empty."*

### `/tl/requests` — raise on behalf of a rep

The same correction form as `/sales/requests/new`, with a rep picker restricted
to this TL's direct reports. The resulting request records the **TL as the
submitter** and the **rep as the owner** — both are shown on it, and only the TL
can resubmit it if it comes back.

### Where a manager appears in each chain

| Chain | TL's step | ACM's step |
|---|---|---|
| AutoPay | — (notified only, cannot block) | — |
| Mapping, within team | step 1 | step 2 |
| Mapping, between teams | step 1 (submitter's TL) | step 2 (submitter's ACM), step 4 (counterparty's ACM) |
| Mapping, DIY | — | — |
| Issuance date | — | — |
| BAU → BFL | — | — |

### What happens when a manager cannot be found

The two failure modes are different problems and the UI must not merge them:

- **The roster places the rep under nobody.** A data gap — chase the Manpower
  sheet. Listed on `/admin/hierarchy` as a rep placed under no one.
- **The roster names a manager who has no portal account.** An account gap —
  chase an administrator. Listed on `/admin/hierarchy` under *Managers without a
  login*, with how many reps it affects.

In both cases the step **opens anyway**, is routed to the administrators, and the
request keeps moving. It is never stranded behind data the reviewer cannot fix,
and the person who just approved it does not have their work rolled back.

---

## 7b. The approval chains — what goes to whom

This is the whole routing model in one place. **A step is one of two kinds**, and
the difference is the thing to get right in the UI:

- **Pool** — anyone holding that role may take it. First one to act wins. Nobody
  is assigned; it sits in a shared queue.
- **Named person** — resolved from the roster for *this specific request*, and
  assigned to exactly them. It appears in their queue and nobody else's.

| Step | Kind | Resolves to |
|---|---|---|
| `TL` | named | The team leader the roster places over the rep — `manpower.tl_id` → the account whose TL code matches |
| `ACM` | named | The area manager over that rep's team — `manpower.ccm_id` → the account whose ACM code matches |
| `ACM (other team)` | named | The same lookup, run against the **counterparty's** SM_ID instead |
| `V1`…`V5 (QA)` | pool | Any active `verifier` |
| `APPROVER` | pool | Any active `approver` |

### Chain by chain

**AutoPay** — `V1 → APPROVER`
| # | Step | Who |
|---|---|---|
| 1 | V1 | any verifier |
| 2 | APPROVER | any approver — applies the change |

The rep's **team leader is notified** when the request is raised, but has no
step and cannot block it. A TL may also raise an AutoPay request on behalf of one
of their own reps.

**Mapping, within one team** — `TL → ACM → V2 → APPROVER`
Chosen when the counterparty rep reports to the *same* team leader.
| # | Step | Who |
|---|---|---|
| 1 | TL | the shared team leader of both reps |
| 2 | ACM | the area manager over that team |
| 3 | V2 | any verifier |
| 4 | APPROVER | any approver — applies the change |

**Mapping, between two teams** — `TL → ACM → V2 → ACM (other team) → APPROVER`
Chosen when the counterparty reports to a *different* team leader.
| # | Step | Who |
|---|---|---|
| 1 | TL | the **submitter's** team leader |
| 2 | ACM | the **submitter's** area manager |
| 3 | V2 | any verifier — the pivot |
| 4 | ACM (other team) | the **counterparty's** area manager |
| 5 | APPROVER | any approver — applies the change |

Both sides consent to a sale moving between books. The submitter's own chain
closes out first; the receiving side is checked last, right before final
approval.

**Mapping, unowned / DIY** — `V2 → APPROVER`
Chosen when the counterparty is nobody real — no roster row, an orphan code, or
no active account. There is no team to route through, so there is no TL or ACM
step; that falls out of the classification rather than being a special case.

**Issuance date** — `V1 → V2 → APPROVER`
Two verifier steps, and the second requires a **different person** from the
first. Two steps exist to get two pairs of eyes; without that rule one verifier
could clear both and the second gate would be decoration.

**BAU → BFL** — `V3 → V4 → V5 (QA) → APPROVER`
Three verifier steps, each requiring a different person from the ones before.
Classified from the record's **source channel** column on the business dashboard.

**Other / Agent ID** — `V1 → APPROVER`
Not named in the requirement; left on the flow they already ran.

### Rules that apply to every chain

- **Return** at any step sends it back to whoever submitted it, with remarks
  required. Resubmitting restarts from step 1 — never from the middle.
- **Reject** is only available on the **last** step. Every earlier step may pass
  or send back, not refuse outright.
- **A step that resolves to nobody** — the roster places the rep under no
  manager, or names a manager with no account — opens anyway and is routed to
  the administrators, with a warning recorded. The request is never stranded
  behind data the reviewer cannot fix.
- **Editing a chain never disturbs work in flight.** A request copies its steps
  when it is raised and finishes on that copy.

### Editing chains — `/admin/workflows/[chainKey]`

The admin can add, remove and reorder steps for any chain:

- Steps are a vertical list, each with a **drag handle**; dragging reorders. The
  drop target is highlighted, the dragged row dims.
- **Up / down arrows** on every row do the same thing, because dragging is
  unusable by keyboard and invisible to a screen reader. They are the accessible
  path, not a fallback.
- **Add a step** is a dropdown of who can decide it — Team leader, Area manager,
  V1…V5 (QA), Approver — and it joins the end for the admin to drag into place.
- A **Team leader** or **Area manager** step also asks which side it applies to:
  *the submitter's team* or *the other team*. That is what makes the two ACM
  steps of a between-teams chain different.
- The **last step is always the one that applies the change and the only one that
  can reject**; the UI states this and enforces it on save rather than letting
  the admin build a chain that can only ever say yes.
- Removing the last remaining step is refused — a chain with no steps accepts
  requests nobody will ever review.
- Saving shows a banner counting requests currently on the chain and reassuring
  that they are unaffected.

---

## 8. The flows, end to end

### A. First run
`/setup` → create the first admin → sign in → `/admin/users` (no accounts yet) →
`/admin/uploads/new` → **import Manpower** → create logins for the roster →
distribute credentials → **import business dashboard** → commit → reps sign in.

### B. Monthly cycle
Admin uploads the workbook → maps columns → reviews validation → commits →
records land and the period opens → reps see their books → reps raise
corrections → each climbs its chain → approved changes rewrite records → admin
exports → admin closes the month.

### C. A correction, in full
Rep raises it → the routing layer picks the chain from the category (and, for
mapping, from whether the counterparty is in the same team, another team, or
nobody at all) → the first rung opens and is notified → each rung approves,
returns, or (last rung only) rejects → on the final approval the record is
rewritten, versioned, and everyone affected is notified.

A **return** at any rung sends it back to whoever submitted it, with remarks,
and resubmission restarts the chain from the first rung.

### D. A mapping dispute between two teams
Rep A claims a sale currently in rep B's book, and they report to different TLs:
`A's TL → A's ACM → V2 → B's ACM → Approver`. Rep B is notified when the request
is raised, not only when it is approved, so they can object while it still
matters.

---

## 9. Design notes for whoever rebuilds this

- **Density over whitespace.** Reviewers work a queue; a decision screen that
  needs scrolling to compare two values costs real time.
- **Status is the primary colour signal.** Six request statuses and six stage
  statuses; they must be distinguishable at a glance and never rely on colour
  alone.
- **Numbers that mean "nobody was told" must be visible.** Several flows return a
  recipient count where zero is a silent failure. Surface it.
- **Every destructive or hard-to-reverse action states its blast radius** before
  it happens: how many rows, whose work, what cannot be undone.
- **Identifiers are never right-aligned as numbers.** Apps_No, SM_ID, policy
  numbers are text.
- **The app is served under a path prefix in production** (`/reconciliation`).
  Any hand-written URL needs the base path; framework navigation handles itself.
