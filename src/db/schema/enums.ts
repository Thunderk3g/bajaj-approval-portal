import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'sales', 'approver']);

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
export const correctionStatusEnum = pgEnum('correction_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'WITHDRAWN',
]);

export const correctionCategoryEnum = pgEnum('correction_category', [
  'AUTOPAY',
  'MAPPING',
  'ISSUANCE_DATE',
  'OTHERS',
]);

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

export const eventActionEnum = pgEnum('event_action', [
  'SUBMITTED',
  'RESUBMITTED',
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
