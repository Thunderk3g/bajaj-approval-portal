import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * `verifier` sits between the salesperson and the approver — 2026-07-28 spec
 * section 3. It carries no SM_ID and sees every record, exactly like `approver`;
 * what separates them is which status each may act on, not what each can read.
 */
/**
 * `tl` and `acm` are appended for the 2026-08-06 multi-stage approval design.
 *
 * They are real logins, not labels: `correction_request.submitted_by`,
 * `correction_event.actor_id` and `notification.user_id` are all hard FKs to
 * `user.id`, so there is no column anywhere a non-account could be recorded as
 * having acted or been notified — and the requirement has a TL raising requests
 * and an ACM approving them.
 *
 * `acm` resolves off `manpower.ccm_id`, not off a new column. The Manpower sheet
 * carries exactly SM/TL/CCM triples; a genuinely separate rung between TL and CCM
 * would resolve to nobody for every SM on day one.
 */
export const roleEnum = pgEnum('role', ['admin', 'sales', 'approver', 'verifier', 'tl', 'acm']);

/**
 * Which approval chain a request runs — 2026-08-06 spec section 3.
 *
 * One level finer than `correctionCategoryEnum`, because MAPPING is one category
 * carrying three structurally different chains: a transfer inside one team needs
 * one TL and one ACM, a transfer between teams needs the ACM of both sides with a
 * verifier between them, and a claim on a policy nobody owns has no team to route
 * through at all. A single list keyed by category cannot express that, and the
 * alternative — branching inside the engine — would put business rules back
 * inside the thing whose whole purpose is not to have any.
 *
 * Computed by the routing layer at submission and frozen on the request, exactly
 * as `period_id` and `direction` already are.
 */
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

/**
 * Where one request sits in one stage of its chain.
 *
 * Deliberately NOT `correctionStatusEnum`. The two answer different questions —
 * "has this stage been decided" against "what is the state of the whole request"
 * — and a request at stage 3 of 5 is simultaneously PASSED on two stages, ACTIVE
 * on one and PENDING on two more. Reusing the request-level enum would make
 * `status` mean something different depending on which table you read it from.
 */
export const stageStatusEnum = pgEnum('stage_status', [
  'PENDING',
  'ACTIVE',
  'PASSED',
  'RETURNED',
  'REJECTED',
  'WITHDRAWN',
]);

/**
 * A reconciliation cycle — one calendar month.
 *
 * Two values and no third: a period is either accepting new correction claims or
 * it is not. Anything finer (DRAFT, LOCKED, ARCHIVED) would need every read path
 * to decide which of them still counts as open, and there is no question the
 * portal asks that the pair cannot answer.
 */
export const periodStatusEnum = pgEnum('period_status', ['OPEN', 'CLOSED']);

/**
 * WITHDRAWN extends the four statuses named in spec section 5.
 *
 * Section 7 grants a sales user the right to withdraw their own open request,
 * but never says what status the row then carries, and the listed set has no
 * answer: the row MUST leave PENDING/RETURNED or the partial unique index of
 * section 5.6 keeps that field locked and the rep can never raise a correct
 * request for it. The only available terminal statuses are APPROVED — which
 * would claim a change was applied — and REJECTED, which asserts an approver
 * refused it when no approver ever saw it.
 *
 * Encoding a withdrawal as REJECTED means every consumer that does not know the
 * convention reports the rep's own cancellation as an approver's decision:
 * approver history, the admin correction list, dashboard throughput, and the
 * `decision` column of the Excel export. That is four places each needing to
 * remember a workaround, and each one silently wrong if it forgets. A distinct
 * value costs one enum member and removes the whole class of error.
 */
/**
 * VERIFIED is the two-stage gate of the 2026-07-28 spec section 3.
 *
 * PENDING now means "awaiting a VERIFIER", not "awaiting an approver" — the
 * approval transaction was re-gated onto VERIFIED, so a request that never
 * passed a verifier has no path to APPROVED at all.
 *
 * It is a distinct status rather than a boolean flag beside PENDING because
 * every consumer already switches on this column: the two queues, the partial
 * unique index, the dashboards and the export's decision column. A flag would
 * leave each of them needing to remember that PENDING means two different
 * things depending on a second field, and be silently wrong wherever it forgot.
 */
export const correctionStatusEnum = pgEnum('correction_status', [
  'PENDING',
  'VERIFIED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'WITHDRAWN',
]);

/**
 * AGENT_ID is the fourth named category — the `Agent_ID` column the business
 * dashboard began carrying.
 *
 * It gets a value of its own rather than riding on OTHERS for the same reason
 * AUTOPAY and ISSUANCE_DATE do: a named category pins the target field in the
 * database enum, where `field_name` is free text written by the client. A rep
 * raising an agent correction through OTHERS could name any field at all, and
 * `resolveTargetField` would believe them — the enum is the only part of the
 * request an approval path can trust without checking.
 *
 * It also makes the queue filterable by it, which is the thing every reviewer
 * asks for first when a new column starts generating disputes.
 *
 * Appended, never inserted. Postgres assigns enum values a sort order at
 * creation and `ALTER TYPE ... ADD VALUE` without BEFORE/AFTER appends; slotting
 * it beside the other named categories would need the type rebuilt, which means
 * dropping every default and constraint that references it.
 */
/**
 * BAU_TO_BFL is the fifth named category — 2026-08-06 spec section 3.
 *
 * Added for the same reason AGENT_ID was, and appended for the same reason: the
 * enum pins the target field where `field_name` is free text, and Postgres
 * assigns enum values their sort order at creation, so slotting it beside the
 * others would need the type rebuilt.
 *
 * It targets `source_channel`, the Business Dashboard column that says whether a
 * policy was booked as BAU or BFL. That column is new to this release — see
 * `CANONICAL_FIELDS` in src/lib/fields.ts; every workbook imported before it
 * lacks the column entirely, which is why the field is not required.
 */
export const correctionCategoryEnum = pgEnum('correction_category', [
  'AUTOPAY',
  'MAPPING',
  'ISSUANCE_DATE',
  'OTHERS',
  'AGENT_ID',
  'BAU_TO_BFL',
]);

/**
 * Which way a mapping correction moves a sale — 2026-07-29 spec section 2.
 *
 * `CLAIM_IN` is the original pull: the gaining rep says a sale in someone
 * else's book is theirs. `TRANSFER_OUT` is the push: the losing rep says a sale
 * in their own book belongs to someone else.
 *
 * Stored rather than derived. Direction is reconstructible at submission —
 * a claim proposes the submitter's own SM_ID, a transfer names another — but
 * not afterwards: `sm_id` is the very column the request rewrites, and an
 * import or a second correction can move the record between submission and
 * approval. A request read back after that point would re-derive its own
 * direction wrongly, and the queue, the timeline, the export and the
 * counterparty list would every one of them inherit the error.
 *
 * The same reasoning that gave WITHDRAWN and VERIFIED their own values above:
 * what every consumer switches on is stored, not recomputed.
 */
export const mappingDirectionEnum = pgEnum('mapping_direction', ['CLAIM_IN', 'TRANSFER_OUT']);

export const batchStatusEnum = pgEnum('batch_status', [
  'DRAFT',
  'MAPPED',
  'VALIDATED',
  'COMMITTED',
  'FAILED',
  'ABORTED',
]);

export const changeTypeEnum = pgEnum('change_type', [
  'IMPORT',
  'CORRECTION',
  'REIMPORT',
  'ADMIN_EDIT',
]);

/**
 * VERIFIED joins the timeline actions.
 *
 * A verifier's return is recorded as RETURNED, the same action an approver's
 * return uses, because the request lands in the same place and the salesperson
 * does the same thing next. Which stage it came back from is answered by the
 * actor's role on the event row, so the timeline reads correctly without a
 * fifth action whose only job is to name the sender.
 */
/**
 * ADVANCED is the generic "a non-final stage passed this on" — 2026-08-06 spec.
 *
 * VERIFIED is kept and keeps its exact meaning for every row already written, and
 * for stage 0 of a chain whose stage 0 is a verifier. What it cannot describe is
 * an ACM passing a mapping request to a second ACM: nothing was verified, and the
 * timeline would claim a stage that never ran. Which stage ADVANCED refers to is
 * on the event row itself (`stage_sequence`/`stage_key`), so one action serves a
 * chain of any length rather than needing a value per rung.
 */
export const eventActionEnum = pgEnum('event_action', [
  'SUBMITTED',
  'RESUBMITTED',
  'VERIFIED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'WITHDRAWN',
  'ADVANCED',
]);

export const rowStatusEnum = pgEnum('row_status', [
  'VALID',
  'INVALID',
  'DUPLICATE',
  'COMMITTED',
  'SKIPPED',
]);
