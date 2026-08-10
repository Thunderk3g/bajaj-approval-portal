# Multi-stage approval workflow — merged design

**Date:** 2026-08-06
**Status:** ready for implementation planning
**Builds on:** `2026-07-28-verifier-and-monthly-cycle-design.md`, `2026-07-29-sm-to-sm-policy-transfer-design.md`
**Merges:** four independent design drafts (workflow engine, org hierarchy, routing rules, admin UI) drafted in parallel and reconciled here.

## 1. Overview

Today every correction request runs the same two-stage chain — verifier, then approver — regardless of what it is. The stakeholder's informal requirement described something richer: an autopay change should at least notify the requester's team lead; a mapping (ownership reassignment) should be signed off by the team leads and area/cluster managers on both sides of the move before it reaches a verifier and final approver; and a new "BAU to BFL" reclassification needs its own multi-person review chain. None of that fits inside two fixed stages, and none of the people who need to act in it — TL, ACM — exist as logins today; they are descriptive text columns on the `manpower` sheet.

This spec turns that requirement into three connected pieces of work: a generic N-stage approval engine that replaces the hardcoded verifier/approver pair, an org-hierarchy module that makes SM → TL → ACM/CCM real, authenticated actors instead of sheet text, and a routing layer that decides — per category, and for MAPPING per direction and location branch — which chain a given request runs. A fourth piece gives admins a screen to edit those chains and the roster without touching code.

The four pieces were designed independently by four agents, each explicitly told to flag rather than guess at points where their design depended on another piece's choices. That produced a handful of real conflicts (chain-versioning mechanism, how ACM is keyed) and, more informatively, several places where three agents independently reached the same answer without seeing each other's work. Section 2 settles the conflicts and records the convergences; the rest of this document is the single design that results.

## 2. Decisions locked in

### Business decisions (stakeholder-confirmed)

- **BAU-to-BFL trigger = the "source channel" field on the Business Dashboard sheet (`Login Data`).** No such field exists in `src/lib/fields.ts`'s `CANONICAL_FIELDS` today — the only "BAU/BFL" surface in the current codebase is the `BFL & BAU` sheet, which is a presentation/dashboard tab explicitly excluded from import (`NON_DATA_SHEETS` in `src/lib/import/parse.ts:20`), and a same-named `Source`/`Source For Jun Target` column that exists only in the *separate* leads pipeline (`ingest/tests/test_workbook.py`, feeding the `lead` table, not `sales_record`). A new canonical field must be added — see §3 — rather than treating this as an existing column.
- **ACM = CCM. Same rung, not a new one.** Reuse `manpower.ccmId`/`ccmName` unchanged; "ACM" is an application-layer label over that same data, not a new database column or a new Manpower-sheet column. The Manpower sheet parses exactly SM/TL/CCM triples today — a genuinely new rung resolves to nobody for every SM on day one.
- **Autopay TL notification is FYI-only, never blocking.** A TL sees a notification when an autopay request touches their team — whether the SM or the TL themself submitted — but cannot gate or return it. It is not a chain stage; it is a plain `notification` row fired alongside stage 0, using the existing `notification` table and org-hierarchy's `resolveTlUser`.
- **The Manpower sheet is the sole source of truth for hierarchy AND for provisioning eligibility — SM, TL, and ACM alike.** Today, `flagOrphans` (`src/lib/import/commit.ts:537-566`) correctly does not fabricate hierarchy for an SM_ID absent from the roster (it inserts a bare `manpower` row with `isOrphan=true` and null TL/CCM), but `scripts/provision-sales-users.ts` grants a real login to *any* SM_ID appearing in the imported `Lead Dump`, with zero cross-check against the Manpower roster — an account, and by extension a hierarchy placement, gets created from mere transactional appearance. This reverses `docs/sales-logins.md`'s documented, deliberately-reasoned stance (provisioning ahead of a lagging roster so a real rep is never locked out). The reversal is intentional and confirmed: an SM_ID, TL code, or ACM/CCM code with no Manpower row does not get an account or hierarchy auto-created under the new system — it surfaces on the admin's orphan/gap worklist (`listHierarchyGaps()`, §5) for manual resolution instead. The known cost of this reversal — a rep with real sales but a roster row that hasn't landed yet is locked out of self-service until an admin adds them — is accepted as part of this decision, not an oversight.

### Technical reconciliations (architecture calls, not open questions)

1. **No chain-versioning table. The snapshot on `correction_request_stage` is the in-flight-immunity mechanism.** At submission, `materializeStages` copies `stageKey`/`resolverKey`/`resolverConfig`/`canReject` from the live `approval_chain_stage` rows into per-request `correction_request_stage` rows. An admin editing `approval_chain`/`approval_chain_stage` afterward has zero effect on already-materialized requests — they never re-read the chain definition. This achieves the same guarantee as an immutable `chainVersionId` pointer with less machinery (no version-history table, no version bump on every edit), so the versioned-pointer design is dropped everywhere it appears.
2. **ACM resolution is SM-keyed, not location-keyed.** `resolveApprover('ACM', smId)` is called once for the submitter's own SM_ID and, for between-team mapping, once more for the counterparty's SM_ID. No canonical location list exists anywhere in the schema (`manpower.location` is free text), so a location-string-keyed resolver has nothing reliable to key on. The chain-preview UI takes two SM_IDs (or one Apps No. plus a resolved counterparty SM_ID), never free-text location input.
3. **The `queueCondition` gap is real and unclosed — flagged, not silently dropped.** The engine's scalable "my queue" listing needs each hierarchy `resolverKey` (`TL_OF_SM`, `ACM_OF_SM`) to optionally supply a SQL-level predicate; without it, `listActionableForUser` degrades to an O(open-requests) per-row resolver call. This is a build-sequence item (§10), owned by the org-hierarchy module, that must close before the queue UI ships — see §4 and §5.
4. **`chainKey` is finer-grained than `correctionCategoryEnum`.** Three independent drafts converged on the same shape without seeing each other's work: separate chains for `MAPPING_WITHIN_TEAM`, `MAPPING_BETWEEN_TEAMS`, `MAPPING_DIY`, plus `AUTOPAY`, `ISSUANCE_DATE`, and a new `BAU_TO_BFL` — worth noting as a confidence signal, not just a tie-break.

## 3. Data model

All additions are additive (new tables/columns/enum values); nothing existing is dropped or renamed. Enum appends follow the codebase's existing house style (append-only, never re-slotted — see `AGENT_ID`'s comment in `src/db/schema/enums.ts`).

### Enums (`src/db/schema/enums.ts`)

```ts
// APPEND to roleEnum — TL/ACM become real logins, scoped like every other role.
export const roleEnum = pgEnum('role', ['admin', 'sales', 'approver', 'verifier', 'tl', 'acm']);

// APPEND to correctionCategoryEnum — BAU-to-BFL is a genuinely new category,
// same reasoning AGENT_ID's comment gives: a named category pins the target
// field (sourceChannel) in the enum rather than trusting free-text field_name.
export const correctionCategoryEnum = pgEnum('correction_category', [
  'AUTOPAY', 'MAPPING', 'ISSUANCE_DATE', 'OTHERS', 'AGENT_ID', 'BAU_TO_BFL',
]);

// APPEND to eventActionEnum — the generic "non-final stage passed" event.
export const eventActionEnum = pgEnum('event_action', [
  'SUBMITTED', 'RESUBMITTED', 'VERIFIED', 'APPROVED', 'REJECTED', 'RETURNED', 'WITHDRAWN', 'ADVANCED',
]);

// NEW — the routing layer's output, one level finer than correctionCategoryEnum.
// MAPPING (one category) fans out to three of these; OTHERS/AGENT_ID keep a
// 1:1 mapping to their own chainKey pending §9's open question on their shape.
export const chainKeyEnum = pgEnum('chain_key', [
  'AUTOPAY',
  'MAPPING_WITHIN_TEAM',
  'MAPPING_BETWEEN_TEAMS',
  'MAPPING_DIY',
  'ISSUANCE_DATE',
  'BAU_TO_BFL',
  'OTHERS',
  'AGENT_ID',
]);

// NEW — per-stage-instance status. Deliberately not correctionStatusEnum:
// a stage's status and the request's overall status answer different
// questions (see the reinterpretation table in §4).
export const stageStatusEnum = pgEnum('stage_status', [
  'PENDING', 'ACTIVE', 'PASSED', 'RETURNED', 'REJECTED', 'WITHDRAWN',
]);
```

`correctionStatusEnum` is **unchanged** — zero new values, zero code changes to `LOCKING_STATUSES`/`WITHDRAWABLE_STATUSES`. Its six existing values are reinterpreted; see §4.

### Workflow engine tables (new file, `src/db/schema/workflows.ts`)

```ts
export const approvalChain = pgTable('approval_chain', {
  id: uuid('id').primaryKey().defaultRandom(),
  chainKey: chainKeyEnum('chain_key').notNull().unique(),
  label: text('label').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  updatedBy: text('updated_by').references(() => user.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const approvalChainStage = pgTable('approval_chain_stage', {
  id: uuid('id').primaryKey().defaultRandom(),
  chainId: uuid('chain_id').notNull().references(() => approvalChain.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  stageKey: text('stage_key').notNull(),          // display label, e.g. 'TL', 'ACM', 'V2', 'APPROVER'
  resolverKey: text('resolver_key').notNull(),     // 'ROLE' | 'TL_OF_SM' | 'ACM_OF_SM'
  resolverConfig: jsonb('resolver_config').notNull().default({}),
  canReject: boolean('can_reject').notNull().default(false), // default false except last stage
}, (t) => [uniqueIndex('approval_chain_stage_unique').on(t.chainId, t.sequence)]);

export const correctionRequestStage = pgTable('correction_request_stage', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => correctionRequest.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  // Everything below is COPIED from approval_chain_stage at submission time —
  // the snapshot that gives in-flight immunity (§2, reconciliation 1).
  stageKey: text('stage_key').notNull(),
  resolverKey: text('resolver_key').notNull(),
  resolverConfig: jsonb('resolver_config').notNull(),
  canReject: boolean('can_reject').notNull(),
  status: stageStatusEnum('status').notNull().default('PENDING'),
  decidedBy: text('decided_by').references(() => user.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  remarks: text('remarks'),
}, (t) => [
  uniqueIndex('correction_request_stage_unique').on(t.requestId, t.sequence),
  // "Index is the guarantee" — mirrors correction_one_open_per_field. Partial
  // unique index enforces at most one ACTIVE stage per request at the DB level.
  uniqueIndex('correction_request_stage_one_active')
    .on(t.requestId).where(sql`${t.status} = 'ACTIVE'`),
]);
```

### `correction_request` additions (`src/db/schema/corrections.ts`)

```ts
chainKey: chainKeyEnum('chain_key'),              // frozen at submission; nullable for pre-migration rows
currentStageSequence: integer('current_stage_sequence').notNull().default(0),
totalStages: integer('total_stages').notNull().default(2), // frozen, mirrors periodId's "stamped once" rule
/**
 * The counterparty's SM_ID for a MAPPING request, frozen at submission.
 * Same reasoning as `direction`'s existing comment: the counterparty is
 * derivable from smId + record.smId/proposedValue at submission time, but
 * record.smId is exactly the column a later correction can rewrite, so a
 * stage resolved days later against a re-read record would resolve against
 * the wrong side. Computed once, using the same logic notifyMappingCounterparty
 * already uses (service.ts:945-987), never re-derived.
 */
counterpartySmId: text('counterparty_sm_id'),
```

### `correction_event` additions

```ts
stageSequence: integer('stage_sequence'),  // nullable — null for SUBMITTED/RESUBMITTED/WITHDRAWN
stageKey: text('stage_key'),               // nullable, same rule
```

### Org hierarchy additions

`src/db/schema/enums.ts` — covered above (`tl`, `acm` appended to `roleEnum`).

`src/db/schema/auth.ts` — two new columns on `user`, mirroring the existing `smId` pattern exactly:

```ts
tlCode: text('tl_code'),   // required iff role='tl', matches manpower.tl_id, uppercase CHECK
acmCode: text('acm_code'), // required iff role='acm', matches manpower.ccm_id, uppercase CHECK
```

`auth/server.ts` — extend Better Auth `additionalFields` with `tlCode`/`acmCode` (`input: false`, same as `smId`). `auth/rbac.ts` — extend the `Role` union and `CreateUserInput`/`SessionUser` with `tlCode?`/`acmCode?`.

`src/db/schema/records.ts` — new table, beside `manpower`:

```ts
export const manpowerOverride = pgTable('manpower_override', {
  id: uuid('id').primaryKey().defaultRandom(),
  smId: text('sm_id').notNull().unique(),
  tlId: text('tl_id'),   // nullable override
  ccmId: text('ccm_id'), // nullable override — this IS the "ACM" override, per ACM=CCM
  overriddenBy: text('overridden_by').notNull().references(() => user.id),
  overriddenAt: timestamp('overridden_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('manpower_override_not_both_null', sql`${t.tlId} IS NOT NULL OR ${t.ccmId} IS NOT NULL`),
]);
```

No FK to `manpower.smId` (admin may pre-stage a reassignment before the sheet catches up). No shadow `sheetTlId`/`sheetCcmId` columns are needed anywhere — `manpower` itself already always holds "what the sheet currently says" (upsert-on-import, unconditional) and `manpowerOverride` holds "what the admin pinned"; the drift signal the admin UI needs (§7) is just `manpower.tlId !== manpowerOverride.tlId` when a row exists in both, no new columns required.

### Routing / source-channel additions

`src/db/schema/records.ts` — new column on `sales_record`:

```ts
sourceChannel: text('source_channel'), // BAU/BFL classification — the field BAU_TO_BFL corrections target
```

`src/lib/fields.ts` — new `CANONICAL_FIELDS` entry (`required: false`, same reasoning as `agentId`: the column is new, older workbooks predate it):

```ts
{
  key: 'sourceChannel',
  label: 'Source channel',
  kind: 'text',
  required: false,
  aliases: ['sourcechannel', 'channel', 'businesstype', 'baubfl', 'bfl', 'bau'],
}
```

The exact literal header this maps to on the current `Login Data` sheet was not found in the codebase during this review (only a same-named `Source` column on the unrelated `Lead Dump` leads pipeline was found) — confirm the real header spelling against the current workbook before finalizing the alias list; the field/column itself, not its exact alias, is the settled part.

`CATEGORY_FIELDS` — new entry: `BAU_TO_BFL: ['sourceChannel']`.

### Audit

`src/lib/audit/actions.ts` — append to `AUDIT_ACTIONS`: `WORKFLOW_CHAIN_STAGE_ADD`, `WORKFLOW_CHAIN_STAGE_REMOVE`, `WORKFLOW_CHAIN_STAGE_REORDER`, `HIERARCHY_REASSIGN`, `HIERARCHY_OVERRIDE_REVERT`.

## 4. Workflow engine mechanics

### `correctionStatusEnum` reinterpretation (zero code changes to `LOCKING_STATUSES`/`WITHDRAWABLE_STATUSES`)

| Status | Meaning under N stages |
|---|---|
| `PENDING` | Stage 0 is ACTIVE, untouched. |
| `VERIFIED` | Stage 0 passed; request sits at any stage 1..N-1. |
| `APPROVED` | The final stage advanced. |
| `REJECTED` / `RETURNED` / `WITHDRAWN` | Unchanged. |

A single-stage chain skips `VERIFIED` entirely (`PENDING` → `APPROVED` direct). `verifiedBy`/`verifiedAt` = stage 0's decider; `reviewedBy`/`approverRemarks` = final stage's decider — byte-identical to today when N=2 (today's exact shape).

### Service surface

```ts
StageContext = { request, record, stage: { sequence, stageKey, resolverKey, resolverConfig } }
StageAuthorization = { kind: 'ROLE', role } | { kind: 'USERS', userIds: string[] } | { kind: 'UNRESOLVED', reason }
StageResolver = { resolve(ctx, tx) -> StageAuthorization, queueCondition?(actor) -> SQL }

registerStageResolver(key, resolver)
resolveStageAuthorization(ctx, tx)
// Built-in 'ROLE' resolver ships with this module itself — day-1 behavior
// (today's verifier→approver flow) is reproducible with zero hierarchy work done.
```

`src/lib/workflows/chains.ts`: `getChain(chainKey)`, `listChains()`, `createChain(chainKey, label)`, `setChainStages(chainId, StageDraft[], actor)` — replaces the **full** stage list transactionally (single write path; see §7 for how granular admin actions delegate to this one function), `setChainActive(chainId, isActive)`.

`src/lib/workflows/engine.ts`:

```ts
materializeStages(tx, requestId, chainKey) -> { stageCount }
  // Called from submitCorrection, replaces today's unconditional PENDING+notifyVerifiers.
  // Throws EMPTY_CHAIN/NO_CHAIN if the chain has zero stages or isActive=false —
  // submission fails closed rather than silently degrading.

resetStages(tx, requestId)
  // Called from resubmitCorrection. Resets to stage-0-ACTIVE using the REQUEST'S
  // OWN frozen list (never re-reads approval_chain) — see §9 open question on
  // whether resubmission should instead re-snapshot the live chain.

closeActiveStage(tx, requestId, 'WITHDRAWN')
  // Called from withdrawCorrection.

decideStage(input) / decideStageWithin(tx, input)
  // Single generic replacement for verifyRequest/returnFromVerification/
  // applyApproval/rejectRequest/returnRequest.

listActionableForUser(actor, page)
  // "My queue" — needs resolver-supplied queueCondition SQL predicates to stay
  // scalable; see the known gap below.
```

`decideStageWithin` order: `FOR UPDATE` lock the ACTIVE stage row → resolve authorization, reject if the actor doesn't satisfy it → **REJECT** (requires `canReject`) / **RETURN** / **ADVANCE-not-last** (stage → `PASSED`, next stage `PENDING` → `ACTIVE`, `currentStageSequence += 1`, request status stays/becomes `VERIFIED`, notify the newly-active stage) / **ADVANCE-last** (delegates to today's `applyApprovalWithin` record-mutation body verbatim, minus the lock+status-write steps the engine now owns itself).

### Data flow

`submit` → `materializeStages` inserts N `correction_request_stage` rows, `currentStageSequence=0`, `totalStages=N`, status stays `PENDING` → stage 0 authorization resolved and notified → `decideStage` per stage, each ADVANCE bumps sequence and notifies the next stage → final ADVANCE mutates `sales_record`/version, `appliedAt`/`appliedVersion` set — exactly today's write path → resubmission (`RETURNED` only) resets via `resetStages`, re-notifies stage 0 → withdrawal closes the active stage.

### Known gap — must close before the queue UI ships

`listActionableForUser` needs each hierarchy `resolverKey` (`TL_OF_SM`, `ACM_OF_SM`) to optionally supply a `queueCondition(actor) -> SQL` predicate for a scalable, join-based "my queue" query. Without it, the listing falls back to resolving every open request's active-stage authorization one row at a time — O(open-requests) per page load. This is not silently accepted: it is a required deliverable of the org-hierarchy module (§5, §10), not an afterthought.

### Edge cases (engine-owned)

- Empty/inactive chain: submission fails closed (`EMPTY_CHAIN`/`NO_CHAIN`).
- Single-stage category: stage 0 is both first and last; ADVANCE goes straight to `APPROVED`/applied.
- Category/chain edited mid-flight: zero effect on already-materialized requests (§2, reconciliation 1) — admin edits only affect requests submitted *after* the edit.
- Stage authorization `UNRESOLVED` (a hierarchy gap): the actor who just advanced the request still commits — a request must never be stranded by the prior actor's legitimate work. The new ACTIVE stage falls back to notifying all active admins and appends to `warnings[]` (reuses the existing idiom from `apply.ts`) rather than inventing a stuck status.
- Concurrent decisions on the same stage: the partial unique index (`correction_request_stage_one_active`) plus `FOR UPDATE`, same pattern as `correction_one_open_per_field`.

## 5. Org hierarchy

### Resolution

`src/lib/hierarchy/queries.ts`:

- `resolveHierarchy(smId) -> HierarchyNode` — `LEFT JOIN manpower_override`, `coalesce(override.tlId, manpower.tlId)` etc. Name resolution: if an id came from an override, resolve the display name from the *provisioned account* (`user.name where tlCode = id`), not the sheet's `tlName` (which may describe a different person once overridden). Returns `tlSource`/`acmSource` (`'override' | 'sheet' | null`) for audit display.
- `resolveApprover(stageRole: 'TL' | 'ACM', smId) -> { status: 'RESOLVED', userId, code } | { status: 'NO_CODE' } | { status: 'NOT_PROVISIONED', code }` — a 3-way result because the two failure modes need different remediation: no code on the sheet (skip the stage, chase data) vs. a code that exists but has no provisioned account (block + alert admin, chase provisioning). `'ACM'` here resolves off `manpower.ccmId`/`manpowerOverride.ccmId` — the ACM=CCM decision means there is exactly one resolver behind both labels, not two.
- `listDirectReports(tlUserId)`, `isDirectReport(tlUserId, smId)` — for TL-raise-on-behalf-of pickers and the server-side authorization check in `actorScope()`.
- `listHierarchyGaps()` — unresolvable TL/ACM, unprovisioned codes, active overrides, **and every SM/TL/CCM code seen in transaction or lead data with no Manpower row at all** (the provisioning-gate worklist required by §2's Manpower-gate decision) — feeds the admin worklist (§7).

**`resolverKey` registrations** (registered against the engine's `registerStageResolver`): `TL_OF_SM` and `ACM_OF_SM`, each taking `resolverConfig: { smSide: 'SUBMITTER' | 'COUNTERPARTY' }` and picking the corresponding SM_ID off the request (`correction_request.smId` for `SUBMITTER`, `correction_request.counterpartySmId` for `COUNTERPARTY` — see §3). Each **must** supply `queueCondition(actor)` closing the known gap in §4 before the queue UI ships (§10).

### Precedence

Override sticky forever until an admin explicitly clears it (sets both `tlId`/`ccmId` back to null, which deletes the row). Re-import never resurrects a sheet value over an active override — `upsertManpower` and `manpowerOverride` are fully separate tables, so no import code changes are needed; the sheet always wins on `manpower` itself, the override table always wins in `resolveHierarchy`. `src/lib/hierarchy/override.ts` exposes `setHierarchyOverride`/`clearHierarchyOverride`, both writing through the existing `writeAudit()` (`entityType: 'manpower_override'`).

### Pin timing — cross-referenced open question

The engine resolves stage authorization when a stage becomes ACTIVE (for notification) and again inside `decideStageWithin` (to check the acting user). Whether that resolution result is **persisted** at stage-entry (pin-at-entry: a later hierarchy reassignment never moves an already-active stage, only future ones) or **re-resolved live** on every decision attempt (a reassignment can unstick a request behind someone who left, but can also silently move an active stage's assignee mid-review) is not settled by anything decided in §2 — it is a genuine, unresolved conflict between this module's own recommendation (pin-at-entry, mirroring how `sales_record`'s `tlId`/`ccmId`/`location` are already denormalized-at-import rather than joined live) and the admin UI's assumption of live lookup. See §9.

### Provisioning — gated on Manpower, for SM, TL, and ACM alike

Per §2's confirmed decision, **no account and no hierarchy placement is created from mere appearance in `lead`/`sales_record` for any role.** This replaces the previous lead-driven SM provisioning philosophy documented in `docs/sales-logins.md` ("the leads are real and the roster sheet is the thing that is behind") — that document's reasoning is no longer the policy and should be revised alongside this implementation, not left describing behavior the code no longer has.

- `scripts/provision-sales-users.ts` gains a Manpower-membership check: an SM_ID must have a `manpower` row (`isOrphan=false`) before an account is created. An SM_ID present in `lead`/`sales_record` but absent from — or still flagged `isOrphan=true` on — `manpower` is **not** provisioned; it is surfaced on `listHierarchyGaps()` instead, same worklist as a TL/ACM gap, for an admin to resolve (either by waiting for the roster to catch up, or by manually adding a `manpowerOverride` row that gives the SM a TL/ACM even before the sheet does).
- New script `scripts/provision-tl-acm-users.ts`, modeled on the same gated pattern: `SELECT DISTINCT tlId/tlName` (and `ccmId/ccmName`) `FROM manpower WHERE isOrphan=false AND ... IS NOT NULL`; skip-if-exists keyed on `user.tlCode`/`acmCode`; same `--dry-run`/`--limit`/`--reset-password` flags as the existing sales script.
- Email pattern: `tl.<code>@bajajlife.com`, `acm.<code>@bajajlife.com` (TL/ACM), unchanged `sm.<code>@bajajlife.com` derivation for sales.
- `listHierarchyGaps()` is the single worklist for all three roles: `{code, name, kind: 'sm'|'tl'|'acm', smCount, accountEmail}[]`, reusing the `?smId=`/`?tlCode=`/`?acmCode=` prefill UX already established by `/admin/users`.

**Known cost, accepted as part of the decision (§2):** a rep with genuinely new sales but no Manpower row yet gets no login until an admin intervenes — a regression from today's "provision ahead of the roster" behavior for the specific case of a brand-new rep mid-cycle. The orphan worklist is what makes this a same-day admin action rather than a silent lockout.

### Edge cases

- Orphan SM/no TL: `resolveHierarchy` returns `tlId: null`; `resolveApprover('TL', smId)` returns `NO_CODE`. Same shape DIY/outside-mapping needs — routing decides the meaning (§6), this module just guarantees a clean signal.
- Rep changes team mid-cycle: recommend pin-at-stage-entry (see above and §9).
- Pinned assignee later deactivated/re-roled: not auto-reassigned (manual admin re-route, out of scope). "My queue" filters `isActive` so a deactivated TL's stuck requests stop appearing as theirs.
- TL notification (autopay FYI): reuses the existing `notification` table as-is; `resolveTlUser(smId)` gives the `userId`, whichever caller fires it inserts a row. No new infrastructure.
- SM/TL/ACM code seen in data but absent from Manpower: no account, no hierarchy — surfaces on `listHierarchyGaps()` (see Provisioning above), never auto-created.

## 6. Routing rules

Grounded against `submitCorrection`/`notifyMappingCounterparty` (`src/lib/corrections/service.ts:945-987`) and `checkTransferTarget` (`service.ts:232-256`).

### Stage sequence per chainKey

| chainKey | Who may submit | Stage sequence | Actor resolution |
|---|---|---|---|
| `AUTOPAY` | SM (own record) or TL-on-behalf-of an SM in their team | `[TL-notify, non-gating] → V1 → APPROVER` | TL-notify is a plain notification (§2), not a chain stage. V1 and APPROVER are role-pool broadcasts (unchanged from today). |
| `MAPPING_WITHIN_TEAM` | SM (own record, or `TRANSFER_OUT` of own record) | `TL → ACM → V2 → APPROVER` | TL = the one shared TL (`submitter.tlId === counterparty.tlId`). ACM = that team's ACM (`resolveApprover('ACM', submitterSmId)` — same either side, since it's the same team). |
| `MAPPING_BETWEEN_TEAMS` | TL-on-behalf-of-SM, or SM directly | `TL(submitter) → ACM(submitter) → V2 → ACM(counterparty) → APPROVER` | TL = submitter's TL (`resolverConfig: {smSide:'SUBMITTER'}`). ACM(1st) = `resolveApprover('ACM', submitterSmId)`. ACM(2nd) = `resolveApprover('ACM', counterpartySmId)` — see classification/dedup rules below. |
| `MAPPING_DIY` | SM only (claiming an unmapped/orphan-owned record) | `V2 → APPROVER` | No TL/ACM stage — the counterparty resolves to nobody real (see below). |
| `ISSUANCE_DATE` | SM (own record) | `V1 → V2 → APPROVER` (recommended order, see §9) | Role-pool broadcasts. No TL/ACM. |
| `BAU_TO_BFL` | SM (own record) | `V3 → V4 → V5(QA) → APPROVER` | Role-pool broadcasts. No TL/ACM. |
| `OTHERS`, `AGENT_ID` | — | Unresolved shape, see §9 | Bootstrapped as today's flat verifier → approver pending an answer. |

Every chain still terminates at the single Approver role/pool — unchanged from today's `notifyActiveApprovers`.

### Between-team mapping — the location branch, spelled out precisely

**Inputs, already on the row or resolvable via one join:**
- `submitterSmId = correctionRequest.smId` (today: the claimant's own ID for `CLAIM_IN`, or the losing rep's ID for `TRANSFER_OUT`).
- `counterpartySmId` (now frozen on the request at submission — §3): `CLAIM_IN` → `record.smId` at submission time (the current/losing owner); `TRANSFER_OUT` → `proposedValue` (the target/gaining owner) — mirrors `notifyMappingCounterparty`'s existing logic exactly, not a new lookup.

**Resolution:** "1st location" = the submitter's own chain (`resolveApprover(role, submitterSmId)`). "2nd location" = the counterparty's chain (`resolveApprover(role, counterpartySmId)`). Reading: the stakeholder's description is one unbroken chain — TL → ACM(1st) → V2 → *if approved* → ACM(2nd) → Approver. Stage 1 (TL) is unambiguously the submitter's own TL, so "1st location" continuing straight after it is the same side, closing out the submitter's own chain; only *after* V2 signs off does the *other* team's ACM get pulled in — the receiving/losing side checked last, right before final approval.

**Classification rule** (derived from data already present, no new columns needed):

```
counterparty = manpower row for counterpartySmId (may be absent)

if counterparty is absent, or isOrphan=true, or has no tlId:
    → MAPPING_DIY
else if counterparty.tlId === submitter.tlId:
    → MAPPING_WITHIN_TEAM
else:
    → MAPPING_BETWEEN_TEAMS
```

**Dedup rule** (recommended default, needs confirmation — §9): if `ACM(1st location) === ACM(2nd location)` (different TLs, same location/ACM), run the ACM stage once, not twice.

**Asymmetric resolvability, worth flagging to implementers:** for `TRANSFER_OUT`, `checkTransferTarget` already refuses submission if the target SM isn't in the roster, so the 2nd-location ACM is always resolvable for a transfer. For `CLAIM_IN` there is no equivalent check on the record's *current* owner — a claim can target a record currently owned by an orphan SM_ID with no roster row, in which case the 2nd-location ACM cannot be resolved and the request degrades to `MAPPING_DIY`-style behavior for that stage (skip-and-flag, §5's `UNRESOLVED` handling).

### Mapping — outside / DIY

"A SM claims a policy unmapped to anyone" matches an existing edge case: `notifyMappingCounterparty` already returns `0` and is documented as normal when a `CLAIM_IN`'s current owner has no active portal account. DIY is a `CLAIM_IN` whose counterparty resolves to nobody real (no manpower row, `isOrphan=true`, or no active `sales` account) — falls out of the classification rule above for free. Not resolved: "unmapped to anyone" could also mean the policy doesn't exist in `sales_record` at all yet (`correction_request.record_id` is `NOT NULL` FK, so there's no request to raise until it does) — see §9.

### TL-notify and raise-on-behalf-of mechanics

**Raise-on-behalf-of, using existing columns, no schema change:** `submittedBy` = the TL's `user.id`; `smId` = the target SM's `sm_id`. `actorScope()` (`service.ts:167-174`) currently hard-refuses anyone but `role === 'sales'` acting on their own `smId` — needs a second branch for `role === 'tl'` supplying a target `smId`, validated via `isDirectReport(tlUserId, smId)`. `submittedBy` + `smId` are sufficient; no third "raised for" column is needed.

**TL notification (autopay):** per §2, fired whenever an autopay request touches the TL's team, whether SM or TL submitted, using `resolveTlUser(smId)` and the existing `notification` table.

### Rejection / return semantics

- Unchanged from today: `REJECTED`/`RETURNED` at any stage routes back to `submittedBy`, regardless of which stage returned it.
- On-behalf-of case: only the TL can resubmit (ownership is keyed on `submittedBy`). Recommend also notifying the SM (FYI) when `submittedBy` ≠ the SM's own account — new behavior, see §9.
- Hierarchy-gap graceful degrade: skip the unresolvable stage rather than block submission, flag for admin — see §9.

## 7. Admin UI

### Pages

```
/admin/workflows                  chain summary table (stage count, active, last edited, in-flight count)
/admin/workflows/[chainKey]       in-flight-impact banner + chain editor + chain preview
/admin/hierarchy                  roster table + "needs a TL/ACM/account" worklist + filters
```

No `/admin/hierarchy/[smId]` — inline row form like `create-user-form.tsx`, prefillable via `?smId=`.

### Components

- `admin/workflows/page.tsx` — chain summary table.
- `admin/workflows/[chainKey]/page.tsx` — in-flight-impact banner + `ChainEditor` + `ChainPreview`. **No version-history panel** (§2, reconciliation 1) — links out to `/admin/audit` filtered to `WORKFLOW_CHAIN_STAGE_*` for this `chainKey` instead; the audit log *is* the history for this release.
- `chain-editor.tsx` (client) — ordered stage rows, move up/down (no drag-and-drop, no new dependency), remove (inline confirm), add-stage mini-form (`resolverKey` select, `stageKey` label, `smSide` select when `resolverKey ∈ {TL_OF_SM, ACM_OF_SM}`).
- `chain-preview.tsx` (client) — **takes an Apps No., or two SM_IDs directly** (§2, reconciliation 2) — resolves to a sequence of badges (role/name), amber "unresolved" badge when a hierarchy lookup fails. No free-text location input anywhere.
- `admin/hierarchy/page.tsx` — "Needs a TL/ACM/account" worklist (`isOrphan || tlId null`, plus §5's new provisioning-gap rows) up top, filter form, main table (SM_ID, name, TL, ACM/CCM, location, provenance badge, drift badge), inline `HierarchyRowForm` per row.
- `hierarchy-row-form.tsx` (client) — TL/ACM SM_ID fields, non-blocking impact-count line, "Accept sheet value" / "Keep my override" buttons shown when `manpower.tlId`/`ccmId` differs from an existing `manpowerOverride` row for that SM (the drift signal — no new schema needed, per §3).

### Server Actions

`src/lib/workflows/actions.ts`: `addChainStageAction`, `removeChainStageAction` (refuses if it would leave zero stages), `moveChainStageAction` — each `requireRole('admin')`, Zod-validated, `writeAudit`, `revalidatePath`. Each computes the new full stage-order array and delegates the actual write to `chains.ts`'s `setChainStages(chainId, stages, actor)` — one transactional full-replace write path underneath three UX-convenient granular actions, not three independent write paths.

`src/lib/hierarchy/actions.ts`: `updateHierarchyAssignmentAction` (writes/updates a `manpowerOverride` row, audits an informational impacted-in-flight-requests count), `revertHierarchyOverrideAction` (deletes the override row). Read-only, unaudited: `previewChainForSampleAction`.

### In-flight protection (rewritten per reconciliation 1 — no `chainVersionId` anywhere)

`correction_request_stage` is a frozen copy of the chain as it existed at submission (§3, §4). Chain edits — add/remove/reorder a stage on `approval_chain_stage` — only affect requests submitted *after* the edit; nothing needs to be pinned or versioned to make that true, because the copy already happened at submission. The in-flight banner on `/admin/workflows/[chainKey]` is informational only, never blocking, stating the in-flight count and this fact — matches the existing "a period close never refuses because work is in flight" house style. No migration/backfill needed on save.

Hierarchy edits are the opposite case: they *can* affect in-flight requests, depending on the answer to §5's pin-timing question and §9's dedicated open question — shown as an impact count before saving, never blocking.

### Concurrency and other details

- `setChainStages` takes `FOR UPDATE` on the `approval_chain` row before replacing its stage rows — two admins editing the same chain simultaneously serialize rather than one silently clobbering the other.
- Zero-stage guard on stage removal.
- Hierarchy reassignment to an unknown account is rejected by `setHierarchyOverride`'s own write path (§5), not re-validated here.
- Roster is ~180 rows — plain pagination, no virtualization.
- Every Server Action calls `requireRole('admin')` itself, never relies on the admin layout for authorization.
- Error handling: reuse the domain-error-class-per-module convention (`PeriodError`-style), mapped to `fail(error.message)`.

## 8. Edge cases (merged, deduplicated)

- **Empty/inactive chain at submission** — fails closed (`EMPTY_CHAIN`/`NO_CHAIN`), never silently degrades to no review.
- **Single-stage chain** — stage 0 is both first and last; ADVANCE applies directly.
- **Chain edited mid-flight** — zero effect on materialized requests (§2, §4, §7).
- **Stage authorization UNRESOLVED** (hierarchy gap at stage-entry) — the request still advances into the new ACTIVE stage; falls back to notifying all active admins and appending to `warnings[]`, never invents a "stuck" status.
- **Concurrent decisions on the same active stage** — partial unique index + `FOR UPDATE`.
- **Orphan SM / no TL** — `resolveApprover` returns `NO_CODE`; routing skips the stage and flags for admin (recommended default, §9).
- **TL with no ACM** — distinguished as `NO_CODE` (sheet gap) vs `NOT_PROVISIONED` (account gap), because the remediation differs (chase data vs. chase admin).
- **Rep changes team mid-cycle** — recommend pin-at-stage-entry; see §5/§9 for the unresolved timing question.
- **Pinned assignee later deactivated** — not auto-reassigned; "my queue" filters `isActive`.
- **`TRANSFER_OUT` vs `CLAIM_IN` asymmetric resolvability** — a transfer's target is always roster-checked at submission (`checkTransferTarget`); a claim's *current owner* is not, so `CLAIM_IN` can land on `MAPPING_DIY`-style handling mid-classification when the current owner is an orphan SM_ID.
- **Between-team ACM(1st) === ACM(2nd)** — recommended to run once, not twice (§6, §9).
- **Outside/DIY when the policy has no `sales_record` row at all** (never imported) — out of scope for correction requests; needs a separate intake mechanism (§9).
- **On-behalf-of submission** — only the TL who submitted can resubmit; recommend also notifying the SM (FYI) on return/reject (§9).
- **Bulk decisions spanning requests at different current stages/actors** — mechanically trivial to keep working, but a prioritization question for release scope (§9).
- **Hierarchy override vs. re-import** — sheet always wins on `manpower`; override always wins in `resolveHierarchy` until explicitly cleared; re-import never silently overwrites an override (fully separate tables, no import code changes).
- **Chain preview / classification with a counterparty that has no roster row** — degrades to `MAPPING_DIY` handling, not a hard error.
- **SM/TL/ACM code seen in data but absent from Manpower** — no account, no hierarchy auto-created (§2, §5); surfaces on the orphan/gap worklist for manual resolution, which is the accepted cost of the Manpower-gate decision.

## 9. Open questions still needing stakeholder input

1. **Can intermediate (non-final) stages reject outright, or only return?** Default: `canReject=false` except the last stage (matches today's verifier-can't/approver-can asymmetry), admin-configurable per stage.
2. **Resubmission after RETURNED: re-snapshot against the live (possibly admin-edited) chain, or keep running the original chain the request was submitted against?** Default: keep original — no surprise scope change mid-conversation with the rep.
3. **Stage authorization UNRESOLVED — is advance-anyway-and-notify-admins (as designed) acceptable, or should the request stall pending an explicit admin re-route/skip action?** Default: advance-anyway-and-notify, as designed.
4. **Should bulk decisions (today's `bulkVerifyDecideAction`/`bulkDecideAction`) stay in scope for the first release**, given a bulk selection may now span requests with different current stages/authorized actors per row? Mechanically trivial either way — a prioritization question, not a feasibility one.
5. **Should a hierarchy override be sticky until cleared (recommended, as designed) or auto-expire on next import** (a one-cycle patch)? Very different admin workflows.
6. **When an SM is reassigned to a new TL/ACM, does a request already sitting at that hierarchy stage move to the new person immediately, or does it stay pinned to whoever was resolved when the stage was entered?** [Dedupes the same question asked three separate ways across the org-hierarchy, routing, and admin-UI drafts.] Default: pin-at-stage-entry, no force-migration — mirrors how `sales_record`'s own `tlId`/`tlName`/`ccmId`/`ccmName`/`location` are already denormalized-at-import rather than joined live. This also determines whether the admin UI's reassignment "impact preview" needs to exist at all.
7. **Do TL/ACM need a scoped record view (own reports only, like sales sees only its own `smId`) or the global view today's verifier/approver have (`GLOBAL_READ_ROLES`)?** Not resolved here — a product decision.
8. **Should `tlCode`/`acmCode` be unique per account** (block two logins sharing one code), **or splittable across co-managers/backups?** Mirrors `smId`'s current lack of a uniqueness constraint.
9. **Issuance-date stage ordering** — the stakeholder's phrasing reads V2-before-V1, inverting the seniority pattern used everywhere else. Recommend V1 → V2 (read as a wording slip); confirm.
10. **Is it deliberate that mapping gets a full gating TL stage while autopay only gets an FYI notification**, or was that an oversight now worth reconsidering given autopay's confirmed FYI-only status? Flagging so the asymmetry isn't "fixed" by accident.
11. **Is "within team" always the same as "same TL"** (this draft's assumption), or could "team"/"location" mean a coarser axis? And when `ACM(1st) === ACM(2nd)` under different TLs, should the chain run the ACM stage once (recommended) or twice?
12. **Are V1–V5/QA fixed global role pools serving every category routed to them, or can an admin assign a different person as "V2" for mapping vs. "V2" for issuance-date?** Relatedly, is `QA`(V5) a distinct role/queue or just a label on the fifth generic slot — and is it scoped to `BAU_TO_BFL` only, or a cross-cutting spot-check across categories? Determines whether the role dropdown in `chain-editor.tsx` is global or scoped per `chainKey`.
13. **Outside/DIY when the target policy has no `sales_record` row at all** (never imported) — needs an intake mechanism outside correction requests entirely; out of scope for this routing design.
14. **`OTHERS` and `AGENT_ID` categories** — not mentioned in the stakeholder's original requirement at all. Keep today's flat two-stage flow (bootstrap default), fold them into a newly designed chain, or was omitting them from the requirement itself an oversight worth revisiting?
15. **Hierarchy-gap behavior at submission** (no TL, no ACM, counterparty not in roster) — recommend skip-and-flag rather than block submission. Confirm this is acceptable given known orphan SM_IDs already present in real data.
16. **Should the SM be notified (FYI) when a TL-submitted request is returned/rejected**, even though only the TL can resubmit it? Recommend yes — new behavior, no precedent today.
17. **Approver seat count** — any reason to move off today's single-seat role? Flagging only because an individual ("Kamil") is named throughout the source material. Default: no change.

## 10. Build sequence

- [ ] **Phase 0 — Schema (additive only).** All of §3 in one migration: `chainKeyEnum`, `stageStatusEnum`, `roleEnum`/`correctionCategoryEnum`/`eventActionEnum` appends, `approvalChain`/`approvalChainStage`/`correctionRequestStage`, `correction_request` + `correction_event` additions, `user.tlCode`/`acmCode`, `manpowerOverride`, `sales_record.sourceChannel`, `AUDIT_ACTIONS` appends.
- [ ] **Phase 1 — Engine core.** `src/lib/workflows/chains.ts`, `engine.ts`, the built-in `'ROLE'` resolver, `registerStageResolver`/`resolveStageAuthorization`.
- [ ] **Phase 2 — Bootstrap.** Seed the 5 existing categories as two-stage `ROLE` chains (verifier → approver), reproducing today's exact behavior. Backfill open requests into their bootstrap chain at their current position. **The engine is shippable at this point, before hierarchy or routing have any real logic.**
- [ ] **Phase 3 — Wire call sites.** `verification/apply.ts` + `approvals/apply.ts` collapse into `engine.ts`; existing exports become thin wrappers so nothing else in the codebase needs to change yet.
- [ ] **Phase 4 — Org hierarchy module.** `src/db/schema` role/user changes already landed in Phase 0; build `src/lib/hierarchy/queries.ts` (`resolveHierarchy`, `resolveApprover`, `listDirectReports`, `isDirectReport`, `listHierarchyGaps`), `override.ts`; register `TL_OF_SM`/`ACM_OF_SM` resolvers **including their `queueCondition` SQL predicates** — this is where the known gap from §4 gets closed, not deferred further.
- [ ] **Phase 5 — Provisioning.** Add the Manpower-membership gate to `scripts/provision-sales-users.ts` (§5); new `scripts/provision-tl-acm-users.ts`; revise `docs/sales-logins.md` to describe the gated behavior rather than the superseded lead-driven policy.
- [ ] **Phase 6 — Routing rules module.** `chainKey` classification logic (within/between/DIY), `sourceChannel` added to `src/lib/fields.ts` + import mapping, `actorScope()`'s new `role === 'tl'` branch, real chain definitions for `AUTOPAY`/`MAPPING_*`/`ISSUANCE_DATE`/`BAU_TO_BFL` created via `chains.ts` CRUD (replacing their bootstrap chains), autopay TL-notify wiring (`resolveTlUser` + `notification` table).
- [ ] **Phase 7 — `listActionableForUser`.** Exposed for the queue UI — blocked on Phase 4's `queueCondition` close-out.
- [ ] **Phase 8 — Admin UI.** Extend `AUDIT_ACTIONS` (done in Phase 0) and nav entries; `/admin/workflows` schema-adjacent actions/queries, pages, `chain-editor.tsx`, `chain-preview.tsx`; `/admin/hierarchy` actions/queries, page, `hierarchy-row-form.tsx`, including the provisioning-gap rows from §5.
- [ ] **Phase 9 — Integration tests.** Chain edit does not affect in-flight requests; re-import does not overwrite an active hierarchy override; queue listing performance with `queueCondition` in place; provisioning scripts refuse an SM/TL/ACM code absent from Manpower.
