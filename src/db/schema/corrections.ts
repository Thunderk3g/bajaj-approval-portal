import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { correctionCategoryEnum, correctionStatusEnum, eventActionEnum } from './enums';
import { user } from './auth';
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
    index('correction_request_status_idx').on(t.status),
    index('correction_request_sm_id_idx').on(t.smId),
    index('correction_request_record_idx').on(t.recordId),
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
