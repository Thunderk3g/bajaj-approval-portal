import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { batchStatusEnum, changeTypeEnum, rowStatusEnum } from './enums';
import { user } from './auth';

export type ColumnMapping = Record<string, string>;

export type RowIssue = {
  field: string;
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
};

export const uploadBatch = pgTable(
  'upload_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    originalFileName: text('original_file_name').notNull(),
    storedPath: text('stored_path').notNull(),
    fileHash: text('file_hash').notNull(),
    sheetName: text('sheet_name'),
    headerRow: integer('header_row').notNull().default(1),
    dateFormat: text('date_format').notNull().default('dd/MM/yyyy'),
    columnMapping: jsonb('column_mapping').$type<ColumnMapping>(),
    totalRows: integer('total_rows').notNull().default(0),
    validRows: integer('valid_rows').notNull().default(0),
    invalidRows: integer('invalid_rows').notNull().default(0),
    duplicateRows: integer('duplicate_rows').notNull().default(0),
    status: batchStatusEnum('status').notNull().default('DRAFT'),
    validationReport: jsonb('validation_report'),
    notes: text('notes'),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => user.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    committedBy: text('committed_by').references(() => user.id),
    committedAt: timestamp('committed_at', { withTimezone: true }),
  },
  (t) => [
    index('upload_batch_status_idx').on(t.status),
    index('upload_batch_hash_idx').on(t.fileHash),
  ],
);

export const uploadBatchRow = pgTable(
  'upload_batch_row',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => uploadBatch.id, { onDelete: 'cascade' }),
    rowNumber: integer('row_number').notNull(),
    raw: jsonb('raw').notNull(),
    normalized: jsonb('normalized'),
    issues: jsonb('issues').$type<RowIssue[]>(),
    isDuplicate: boolean('is_duplicate').notNull().default(false),
    duplicateOfRow: integer('duplicate_of_row'),
    status: rowStatusEnum('status').notNull().default('VALID'),
  },
  (t) => [
    uniqueIndex('upload_batch_row_unique').on(t.batchId, t.rowNumber),
    index('upload_batch_row_status_idx').on(t.batchId, t.status),
  ],
);

export const salesRecord = pgTable(
  'sales_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Identifiers are text, never numeric: they are never arithmetic operands,
    // and numeric storage reintroduces the 5.92E+09 formatting seen in source.
    appsNo: text('apps_no').notNull().unique(),
    policyNo: text('policy_no'),
    clientName: text('client_name'),
    leadId: text('lead_id'),
    smId: text('sm_id').notNull(),
    smName: text('sm_name'),
    tlId: text('tl_id'),
    tlName: text('tl_name'),
    ccmId: text('ccm_id'),
    ccmName: text('ccm_name'),
    location: text('location'),
    loginDate: date('login_date'),
    issuedDate: date('issued_date'),
    fp: numeric('fp', { precision: 18, scale: 2 }),
    anp: numeric('anp', { precision: 18, scale: 2 }),
    productName: text('product_name'),
    productType: text('product_type'),
    productVariant: text('product_variant'),
    bookingFrequency: text('booking_frequency'),
    payMode: text('pay_mode'),
    status: text('status'),
    status2: text('status_2'),
    autopay: text('autopay'),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    sourceBatchId: uuid('source_batch_id').references(() => uploadBatch.id),
    sourceRowNumber: integer('source_row_number'),
    currentVersion: integer('current_version').notNull().default(1),
    hasCorrections: boolean('has_corrections').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('sales_record_sm_id_uppercase', sql`${t.smId} = upper(${t.smId})`),
    index('sales_record_sm_id_idx').on(t.smId),
    index('sales_record_status_idx').on(t.status),
    index('sales_record_issued_date_idx').on(t.issuedDate),
    index('sales_record_policy_no_idx').on(t.policyNo),
  ],
);

/**
 * The rep roster — the `Manpower` sheet of spec section 13.1.
 *
 * Two jobs, both of which need a table rather than a derived query.
 *
 * Approving a mapping claim must resolve the gaining rep's `sm_name` from the
 * roster rather than trusting free text (section 7.2): `sm_id` and `sm_name` are
 * never allowed to diverge, and a typed name would let them. Deriving the name
 * from existing `sales_record` rows instead would be circular — a rep with no
 * records yet has no name to derive, which is precisely the case when a sale is
 * being reassigned TO them.
 *
 * It is also the source for provisioning sales accounts. Seven `SM_ID`s in the
 * June `Login Data` have no roster entry, including one purely numeric ID
 * (512454), so `isOrphan` marks an ID seen in transaction data but absent from
 * the roster. Those get an account on first appearance and are flagged for
 * admin review rather than silently dropped.
 */
export const manpower = pgTable(
  'manpower',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    smId: text('sm_id').notNull().unique(),
    smName: text('sm_name'),
    tlId: text('tl_id'),
    tlName: text('tl_name'),
    ccmId: text('ccm_id'),
    ccmName: text('ccm_name'),
    location: text('location'),
    /** Seen in transaction data but missing from the roster — section 13.2 note 7. */
    isOrphan: boolean('is_orphan').notNull().default(false),
    sourceBatchId: uuid('source_batch_id').references(() => uploadBatch.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mirrors the sales_record constraint: a roster row keyed by a lowercase
    // SM_ID would never join to the records it is supposed to name.
    check('manpower_sm_id_uppercase', sql`${t.smId} = upper(${t.smId})`),
    index('manpower_orphan_idx').on(t.isOrphan),
  ],
);

export const salesRecordVersion = pgTable(
  'sales_record_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => salesRecord.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    data: jsonb('data').notNull(),
    changeType: changeTypeEnum('change_type').notNull(),
    changedFields: text('changed_fields').array(),
    changedBy: text('changed_by').references(() => user.id),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
    correctionRequestId: uuid('correction_request_id'),
    batchId: uuid('batch_id').references(() => uploadBatch.id),
    note: text('note'),
  },
  (t) => [uniqueIndex('sales_record_version_unique').on(t.recordId, t.version)],
);
