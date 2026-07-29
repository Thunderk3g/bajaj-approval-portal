import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  correctionCategoryEnum,
  correctionStatusEnum,
  eventActionEnum,
  mappingDirectionEnum,
} from './enums';
import { user } from './auth';
import { period } from './periods';
import { salesRecord } from './records';

export const correctionRequest = pgTable(
  'correction_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => salesRecord.id, { onDelete: 'cascade' }),
    appsNo: text('apps_no').notNull(),
    category: correctionCategoryEnum('category').notNull(),
    /**
     * Which way a MAPPING request moves the sale — 2026-07-29 spec section 3.2.
     *
     * Null on every other category, where it has no meaning. The pairing is a
     * CHECK below rather than a service-layer rule: a MAPPING row with no
     * direction cannot be rendered, and a direction on an AUTOPAY row would be
     * read by nothing and mean nothing.
     */
    direction: mappingDirectionEnum('direction'),
    fieldName: text('field_name').notNull(),
    fieldLabel: text('field_label').notNull(),
    originalValue: text('original_value'),
    proposedValue: text('proposed_value').notNull(),
    description: text('description'),
    submittedBy: text('submitted_by')
      .notNull()
      .references(() => user.id),
    smId: text('sm_id').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
    status: correctionStatusEnum('status').notNull().default('PENDING'),
    /**
     * The cycle this claim was raised in — 2026-07-28 spec section 4.3.
     *
     * Stamped once at submission and never changed. If the record moves to a
     * newer period next month the request still belongs to the cycle it was
     * raised in; otherwise closing a month would retroactively drag in work
     * that was never part of it.
     *
     * Null on rows that predate periods. Null is NOT an open period — the close
     * guard treats it as unconstrained, so a pre-period record stays correctable.
     */
    periodId: uuid('period_id').references(() => period.id),
    /**
     * The verification stage — spec section 3.5. Deliberately separate from the
     * `reviewed*` columns below rather than reusing them: the two stages are
     * answered by different people and both answers must survive. An audit that
     * can only name one reviewer cannot say whether a bad correction got through
     * because the verifier missed it or because the approver overrode them.
     */
    verifiedBy: text('verified_by').references(() => user.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifierRemarks: text('verifier_remarks'),
    reviewedBy: text('reviewed_by').references(() => user.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    approverRemarks: text('approver_remarks'),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedVersion: integer('applied_version'),
    resubmissionCount: integer('resubmission_count').notNull().default(0),
    lastResubmittedAt: timestamp('last_resubmitted_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'correction_others_requires_description',
      sql`${t.category} <> 'OTHERS' OR (${t.description} IS NOT NULL AND length(trim(${t.description})) > 0)`,
    ),
    /**
     * Direction belongs to MAPPING and to nothing else — spec section 3.2.
     *
     * Written as an equivalence so it catches both halves at once: a MAPPING
     * row that forgot its direction, and a direction stamped on a category that
     * has no use for one. Either would be a row no consumer knows how to read.
     */
    check(
      'correction_direction_iff_mapping',
      sql`(${t.category} = 'MAPPING') = (${t.direction} IS NOT NULL)`,
    ),
    index('correction_request_status_idx').on(t.status),
    index('correction_request_sm_id_idx').on(t.smId),
    index('correction_request_record_idx').on(t.recordId),
    index('correction_request_period_idx').on(t.periodId),
  ],
);

export const correctionAttachment = pgTable(
  'correction_attachment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => correctionRequest.id, { onDelete: 'cascade' }),
    storedPath: text('stored_path').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => user.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('correction_attachment_request_idx').on(t.requestId)],
);

export const correctionEvent = pgTable(
  'correction_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => correctionRequest.id, { onDelete: 'cascade' }),
    action: eventActionEnum('action').notNull(),
    actorId: text('actor_id').references(() => user.id),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    remarks: text('remarks'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('correction_event_request_idx').on(t.requestId, t.createdAt)],
);
