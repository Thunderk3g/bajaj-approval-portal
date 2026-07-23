import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'sales', 'approver']);

export const correctionStatusEnum = pgEnum('correction_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'RETURNED',
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
