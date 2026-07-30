import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * `verifier` sits between the salesperson and the approver — 2026-07-28 spec
 * section 3. It carries no SM_ID and sees every record, exactly like `approver`;
 * what separates them is which status each may act on, not what each can read.
 */
export const roleEnum = pgEnum('role', ['admin', 'sales', 'approver', 'verifier']);

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
export const correctionCategoryEnum = pgEnum('correction_category', [
  'AUTOPAY',
  'MAPPING',
  'ISSUANCE_DATE',
  'OTHERS',
  'AGENT_ID',
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
export const eventActionEnum = pgEnum('event_action', [
  'SUBMITTED',
  'RESUBMITTED',
  'VERIFIED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'WITHDRAWN',
]);

export const rowStatusEnum = pgEnum('row_status', [
  'VALID',
  'INVALID',
  'DUPLICATE',
  'COMMITTED',
  'SKIPPED',
]);
