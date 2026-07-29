# SM-to-SM policy transfer — design

**Date:** 2026-07-29
**Status:** approved for implementation
**Builds on:** `2026-07-23-sales-disposition-reconciliation-portal-design.md` §7.2,
`2026-07-28-verifier-and-monthly-cycle-design.md` §3

## 1. The gap

`MAPPING` corrections already reassign a sale between reps, and the machinery is complete:
the Zod branch, the cross-scope lookup, the roster-resolved `sm_name`, the two-party approver
panel, and the `MAPPING_LOST` / `MAPPING_GAINED` notification pair.

All of it runs in **one direction only**. `submitCorrection` pins `proposedValue` to the
claimant's own `SM_ID` and refuses a record the claimant already owns, so the category answers
exactly one question: *"this sale in someone else's book is mine."* A **pull**.

The unanswered question is its mirror: *"this sale in my book belongs to someone else."* A
**push**. A rep who knows a policy is misattributed to them cannot say so. Their only recourse
today is to ask the rep who should own it to raise a claim — which requires that rep to know
the application exists, and leaves the correction depending on a conversation the portal never
sees.

### 1.1 The unsanctioned push that already exists

The `OTHERS` category may name any canonical field except `apps_no`
(`OTHERS_FORBIDDEN_FIELDS = {'appsNo'}`), and `CATEGORY_FIELDS.OTHERS` is every canonical key —
including `smId`. So `resolveTargetField('OTHERS', 'smId')` returns `smId`, and a rep can
already push a policy out of their book today.

It does so **badly**, because `isMapping` is `category === 'MAPPING'` and an `OTHERS` request
fails that test:

- `sm_id` is rewritten and **`sm_name` is left holding the previous rep's name** — precisely the
  divergence §6.7 forbids, and which the `MAPPING` branch exists to prevent.
- `changedFields` records `['smId']` alone, so the version note and the `RECORD_UPDATE` audit
  row under-report what changed.
- Neither rep is notified. The record leaves one book and appears in another in silence — the
  failure §7.2 calls "indistinguishable from data loss."

This is a live defect, not a hypothetical. Closing it is in scope: once a sanctioned push
exists, `smId` joins `appsNo` in `OTHERS_FORBIDDEN_FIELDS` and the back door shuts.

## 2. Shape: one category, two directions

`MAPPING` gains a direction. It does **not** gain a sibling category.

| Direction | Submitter | `proposed_value` | Ownership rule |
|---|---|---|---|
| `CLAIM_IN` | the **gaining** rep | pinned to the submitter's own `SM_ID` | record must **not** already be theirs |
| `TRANSFER_OUT` | the **losing** rep | the **target** rep's `SM_ID` | record **must** be theirs |

Both write `sm_id` and roster-resolved `sm_name` through the same `isMapping` branch of
`applyApprovalWithin`, and both pass the same verifier → approver gate.

**Why one category rather than two.** The apply transaction, the two-party approver panel, the
roster resolution, the `MAPPING_LOST`/`MAPPING_GAINED` pair and the export's decision column are
all already written against "the record's current owner" and "the proposed owner" — never
against who did the asking. A second category would duplicate every one of them, and each copy
is a place the two can drift into disagreeing about who owns a record.

Decisively: `correction_one_open_per_field` is unique on `(record_id, field_name)` where the
status is open. Because both directions target `field_name = 'smId'`, the existing index
already makes **a claim-in and a transfer-out on the same record mutually exclusive**. Split
across two categories the field is still `smId` so the index would still hold — but the rule
would then be an accident of a shared field name rather than a stated invariant. One category
states it.

### 2.1 Why an explicit column and not a derived flag

Direction is derivable at submission — `CLAIM_IN` is `proposed_value == submitter.sm_id`,
`TRANSFER_OUT` is `record.sm_id == submitter.sm_id` — but it is not derivable *later*. The
record's `sm_id` is exactly the column the request rewrites, and a record can be reassigned by
an import or a second correction between submission and approval. A request read back after
that point would re-derive its own direction wrongly, and every consumer — queue, timeline,
export, counterparty list — would inherit the error.

This is the same reasoning that gave `WITHDRAWN` its own status rather than a flag beside
`REJECTED`, and `VERIFIED` its own status rather than a boolean beside `PENDING`: a value every
consumer switches on is stored, not reconstructed.

## 3. Schema

### 3.1 New enum

```ts
export const mappingDirectionEnum = pgEnum('mapping_direction', ['CLAIM_IN', 'TRANSFER_OUT']);
```

### 3.2 New column on `correction_request`

```ts
direction: mappingDirectionEnum('direction'),
```

Nullable, because it is meaningless on the other three categories. The pairing is enforced in
the database rather than trusted to the service:

```sql
ALTER TABLE correction_request ADD CONSTRAINT correction_direction_iff_mapping
  CHECK ((category = 'MAPPING') = (direction IS NOT NULL));
```

A `MAPPING` row without a direction, or a direction on an `AUTOPAY` row, is unrepresentable.
This is the third enforcement layer the codebase already uses for the `OTHERS` description rule
— form convenience, Zod control, database backstop.

### 3.3 Backfill

Every existing `MAPPING` row is a claim by construction, since the pull was the only path that
could produce one:

```sql
UPDATE correction_request SET direction = 'CLAIM_IN'
 WHERE category = 'MAPPING' AND direction IS NULL;
```

The backfill runs **before** the CHECK is added, in the same migration.

### 3.4 Index

```sql
CREATE INDEX correction_request_proposed_sm_idx
  ON correction_request (proposed_value)
  WHERE category = 'MAPPING' AND status IN ('PENDING', 'VERIFIED', 'RETURNED');
```

The counterparty list (§5) looks up open mapping requests by the *proposed* `SM_ID`. Partial, so
it indexes only the open mapping rows the query can actually return, and stays small as decided
requests accumulate.

## 4. Submission

### 4.1 Identifying the policy

A rep pushing a sale out **already owns the record**, so this needs no scoping exception at all
— none of §7.2's lookup apparatus applies. The record is resolved inside the rep's own book.

Both identifiers are accepted, because the requirement is stated in terms of policy numbers and
reps hold policy numbers:

```
resolveOwnRecord(scope, identifier) →
  1. exact match on apps_no   WHERE sm_id = scope.smId
  2. exact match on policy_no WHERE sm_id = scope.smId
```

Application number is tried first: it is unique by constraint, `policy_no` is neither unique nor
`NOT NULL`. If the policy-number arm matches **more than one** record the submission is refused
and the rep is asked for the application number — resolving to an arbitrary one of several would
transfer a policy nobody named. A policy number matching nothing in the rep's own book returns
the same "not in your book" message the ownership check already produces, so the form cannot be
used to probe whether a policy number exists elsewhere.

### 4.2 Validating the target

`TRANSFER_OUT` validates the destination at **submission**, not only at approval:

1. `normalizeSmId` — uppercased, so `c2cm21350` and `C2CM21350` are one rep.
2. **Must not be the submitter's own `SM_ID`.** A transfer to yourself is a no-op that would
   still consume the record's one open-request slot.
3. **Must exist in `manpower`.** The roster is already the authority that resolves `sm_name` at
   approval; an ID absent from it produces a reassignment with a blank name.

The roster check is a hard refusal here and remains a *warning* at approval. The two are not
redundant: submission-time refusal keeps a request that cannot be applied cleanly out of the
verifier's queue, while the approval-time warning still fires for the case the submission check
cannot see — a roster row deleted, or its `sm_name` blanked, in the interval between the two.

`CLAIM_IN` keeps its existing pin to the submitter's own `SM_ID`, unchanged.

### 4.3 What is stored

`correction_request.sm_id` continues to hold **the submitter's** `SM_ID`, not the record's. That
column answers "whose claim is this", and both directions have the same answer. Direction is
what distinguishes them, and it now has its own column.

## 5. The counterparty view — "flagged in both buckets"

Today an open request is visible only to its submitter: every query in
`src/lib/corrections/queries.ts` filters on `submitted_by = actor.id`. The counterparty learns
of a reassignment only when it is **approved** and a `MAPPING_LOST` / `MAPPING_GAINED`
notification arrives. For a push this is too late — the receiving rep should see a policy heading
for their book while it can still be corrected.

A new list, on both sides, and **direction-agnostic** so it closes the same gap for claims:

> **Open mapping requests where I am the counterparty:**
> `category = 'MAPPING'` AND `status IN ('PENDING','VERIFIED','RETURNED')`
> AND (`record.sm_id = :mySmId` OR `proposed_value = :mySmId`)
> AND `submitted_by <> :myUserId`

The final clause is what makes it a *counterparty* list rather than a second copy of "my
requests" — the submitter already sees it under `/sales/requests`.

### 5.1 Why not widen the record list

The obvious alternative is to make an incoming record appear in the receiving rep's
`/sales/records`. That means widening `scopedRecordCondition` — the single helper whose doc
comment calls it "the only sanctioned way to scope record reads", and whose sales branch throws
rather than return `undefined` precisely so a scoping bug cannot become a full-table read.

The counterparty list gets the same information to the same rep without touching it. It reads
`correction_request` joined to `sales_record` under its own explicit predicate and returns a
**restricted projection** — application number, policy number, client name, product, status,
issued date, the two `SM_ID`s and the request's status. No premium figures, no attachments,
matching the projection §7.2 already established for showing a rep a record outside their book.

Read scoping stays exactly as it is. That is the point.

### 5.2 Surface

`/sales/requests` gains a second section, **"Involving my book"**, rendered under the existing
"My requests" table and suppressed entirely when empty. Each row states the direction in the
rep's own terms — *"{SM} is claiming this sale"* or *"{SM} is transferring this sale to you"* —
its current stage, and links to a read-only detail view.

Read-only is deliberate. §7.2 settled that the counterparty is **notified, not consulted**, and
the answer to Q1 of this design confirmed it: there is no accept, no reject, no objection. A
contest state deadlocks reconciliation whenever a rep ignores the prompt, and the verifier and
approver are the decision-makers. A counterparty who disagrees raises their own request, which
the open-request index correctly makes them wait for the first one to resolve.

## 6. Notifications

Two new types, mirroring the existing `MAPPING_LOST` / `MAPPING_GAINED` pair, both fired at
**submission** to the counterparty only:

| Type | Recipient | Fires when |
|---|---|---|
| `MAPPING_CLAIM_RAISED` | the current owner | a `CLAIM_IN` is submitted against a record in their book |
| `MAPPING_TRANSFER_PROPOSED` | the target rep | a `TRANSFER_OUT` naming their `SM_ID` is submitted |

Distinct types rather than one, because the recipient's reading differs: one is *someone wants
something you hold*, the other is *something is coming to you*. `notification.type` is a `text`
column, so neither needs a migration.

Resubmission after a return re-notifies, using the same types — the counterparty was told about
a request that then changed, and the changed one is the one that matters.

The approval-time `MAPPING_LOST` / `MAPPING_GAINED` pair is **unchanged**. Both are already
computed from `record.sm_id` (losing) and `proposedValue` (gaining) with no reference to who
submitted, so they are direction-agnostic already. Only their body text needs adjusting: today
it reads "An approved mapping claim moved this sale…", which misdescribes a transfer. The
wording becomes direction-aware.

Zero recipients continues to be recorded in audit metadata rather than swallowed, per the
existing `verifiersNotified` convention.

## 7. Review surfaces

`mappingContext` already resolves both parties from `manpower` and the portal accounts, keyed on
current-owner and proposed-owner — with no notion of who submitted. It is reused unchanged.

`MappingPanel` gains one line: which party initiated, and in which direction. Without it the
panel shows two reps and no indication of who is asking, which for a transfer is the difference
between a rep giving a sale away and a rep taking one.

The verifier's existing cautions — no proof, live-value drift, roster gap — all apply unchanged.
One is added for `TRANSFER_OUT`: the target rep has no active portal account, so an approved
transfer would move the policy into a book nobody can see.

The queue tables need no structural change. `CategoryBadge` renders `MAPPING` as `warning`
already; direction shows in the field sub-label beneath it.

## 8. Applying an approval

**No change to the transaction.** `applyApprovalWithin`'s `isMapping` branch reads
`record.smId` for the losing side and the coerced `proposedValue` for the gaining side, resolves
`sm_name` from `manpower`, writes `changedFields = ['smId','smName']`, and versions the result.
Every one of those is stated in terms of the record's owner and the proposed owner, never the
submitter.

That the push required no change to the apply path is the evidence that one-category-two-
directions is the right cut.

The submitter-dedupe at step 7 continues to hold: for `TRANSFER_OUT` the submitter is the losing
rep, receives `MAPPING_LOST`, and their `CORRECTION_APPROVED` is correctly suppressed as the
less informative of the two.

## 9. Closing the `OTHERS` back door

`OTHERS_FORBIDDEN_FIELDS` becomes `{'appsNo', 'smId'}`.

`appsNo` is forbidden because correcting it would orphan the request's own history. `smId` is
forbidden for a different reason: not that it must never change, but that it must never change
*this way*. Reassignment has a category that resolves `sm_name`, notifies both reps, records
both changed fields and shows the approver who is on each side. `OTHERS` does none of that, and
a rep reaching it for `smId` gets a silent half-migration.

Both directions of `MAPPING` are now reachable from the form, so nothing legitimate is lost.

Existing `OTHERS`-on-`smId` rows, if any, are left alone — the value is still applicable and
rewriting history to fit a new rule is worse than the rows. `resolveTargetField` keeps accepting
them; only new submissions are refused.

## 10. Testing

**Unit** — the `TRANSFER_OUT` Zod branch (self-transfer refused, unknown roster ID refused,
lowercase target uppercased); direction resolution; `OTHERS` refusing `smId`.

**Integration** — the cases that carry the risk:

- A transfer submitted by the owner reaches `PENDING` with `direction = 'TRANSFER_OUT'` and
  notifies the target, not the submitter.
- A transfer against a record the rep does **not** own is refused with the same message as any
  other cross-book correction — a push cannot be used to move a stranger's policy.
- A policy number matching two records in the rep's book is refused rather than resolved.
- A claim-in and a transfer-out on the same record: the second is refused by
  `correction_one_open_per_field`, asserted through `expectDbError`.
- The full path — transfer submitted, verified, approved — moves `sm_id` **and** `sm_name`,
  writes one version with `changedFields = ['smId','smName']`, and delivers `MAPPING_LOST` to the
  submitter and `MAPPING_GAINED` to the target.
- The counterparty list shows an open transfer to its target and to nobody else; it excludes the
  submitter's own request; it disappears once the request is decided.
- The database CHECK rejects a `MAPPING` row with a null direction and an `AUTOPAY` row with one.
- Concurrency: two simultaneous approvals of the same transfer, one wins — via
  `Promise.allSettled`, matching the existing verification-flow test.

**Not tested**: that the apply transaction handles a transfer, beyond the end-to-end case. It is
the same code path the existing claim tests already cover, and asserting it twice tests the test.

## 11. Out of scope

- **Target acceptance / objection.** Settled in §5.2: notified, not consulted.
- **Bulk transfer.** A rep handing over a territory wants to move dozens of policies at once.
  Real, but it is a different feature — batch selection, partial failure, one verifier decision
  over many records — and folding it in now would compromise the single-record path.
- **Transfer of a record whose period is closed.** The existing `BEFORE INSERT` period trigger
  applies unchanged; a transfer is a correction and obeys the same cycle rules.
- **`OTHERS`-on-`smId` rows already in the database.** §9.
