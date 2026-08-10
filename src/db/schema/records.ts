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
import { period } from './periods';

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
    /**
     * Which monthly cycle this file is for — 2026-07-28 spec section 4.3.
     *
     * A `YYYY-MM` CODE, deliberately NOT a foreign key to `period`.
     *
     * An FK would require the period row to exist at upload time, which means
     * uploading a workbook would open a month. A batch then aborted — wrong
     * file, bad mapping, too many errors — would have opened a reconciliation
     * cycle and closed the previous one on the strength of a file nobody
     * committed, and reps would have silently lost the ability to correct last
     * month because somebody picked the wrong file.
     *
     * The code records the admin's INTENT; `commitBatch` resolves it to a real
     * period inside the commit transaction, when the data actually lands.
     */
    periodCode: text('period_code'),
    uploadedBy: text('uploaded_by')
      .notNull()
      .references(() => user.id),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    committedBy: text('committed_by').references(() => user.id),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    /**
     * When this upload's `Manpower` sheet was committed to the roster.
     *
     * A separate step from committing the policies, and it comes first. The roster
     * is what places every rep under a team leader and that leader under an area
     * manager; the transaction sheet is then mapped AGAINST that hierarchy. Doing
     * both in one pass — which is what this used to do — meant the roster was
     * written from whatever Manpower sheet happened to be in the same workbook, as
     * a side effect of importing policies, with nobody having looked at it.
     *
     * Null means the roster step has not been run for this upload. The policy
     * commit refuses while a roster does not exist at all.
     */
    rosterCommittedAt: timestamp('roster_committed_at', { withTimezone: true }),
    rosterCommittedBy: text('roster_committed_by').references(() => user.id),
    rosterRowCount: integer('roster_row_count').notNull().default(0),
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
    /**
     * The agent credited with sourcing the sale — the `Agent_ID` column added to
     * the business dashboard.
     *
     * Text and nullable, like every other identifier here: it is never an
     * arithmetic operand, and no row that predates the column has one. Carries
     * no uppercase CHECK — unlike `sm_id`, nothing scopes a book by it, so the
     * mixed-case collapse that constraint exists to prevent has no equivalent
     * failure here, and forcing a case the source does not use would make the
     * portal's value differ from the dashboard's for no gain.
     */
    agentId: text('agent_id'),
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
    /**
     * Whether the policy was booked as BAU or BFL — the Business Dashboard's own
     * source-channel column, and the field a BAU_TO_BFL correction targets
     * (2026-08-06 spec section 3).
     *
     * Text and nullable like every other descriptive column here: the workbook
     * spells the two values itself and the portal has no reason to constrain them
     * to an enum it would then have to migrate every time the business adds a
     * third channel. Nullable because the column post-dates every workbook
     * already imported.
     */
    sourceChannel: text('source_channel'),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * The most recent cycle whose file carried this record — spec section 4.3.
     *
     * A record re-imported in the August file becomes August's workload. A
     * record ABSENT from that file keeps its old period, which is exactly the
     * "not in latest batch" state of base-spec section 6.8, now expressed as
     * data rather than as an absence you have to go looking for.
     */
    periodId: uuid('period_id').references(() => period.id),
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
    index('sales_record_period_idx').on(t.periodId),
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

/**
 * An admin's correction to the roster, layered ON TOP of the sheet — 2026-08-06
 * spec section 3.
 *
 * Never written by import. `upsertManpower` keeps overwriting `manpower` from
 * whatever the latest workbook says, exactly as it does today, and this table is
 * consulted only by `resolveHierarchy`. That separation is the whole design: a
 * re-import cannot silently clobber an admin's fix, and an admin's fix cannot
 * silently hide what the sheet actually said — both remain readable, separately,
 * which is what lets the admin screen show the drift between them without a
 * single extra column.
 *
 * The override is sticky until an admin clears it, never auto-expiring on the
 * next import. A self-clearing override is the trap this codebase's enum comments
 * already argue against elsewhere: an admin fixes a wrong TL, the next upload
 * un-fixes it, and nothing on any screen says why a request suddenly routed to
 * somebody else.
 *
 * No FK to `manpower.sm_id`, deliberately — an admin may need to stage a
 * reassignment before the sheet has caught up with it, which is the exact case
 * the table exists for.
 */
export const manpowerOverride = pgTable(
  'manpower_override',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    smId: text('sm_id').notNull().unique(),
    /** Null means "no override for this rung, defer to the sheet". */
    tlId: text('tl_id'),
    /** The ACM override. Named `ccm_id` because ACM and CCM are one rung (spec §2). */
    ccmId: text('ccm_id'),
    reason: text('reason'),
    overriddenBy: text('overridden_by')
      .notNull()
      .references(() => user.id),
    overriddenAt: timestamp('overridden_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('manpower_override_sm_id_uppercase', sql`${t.smId} = upper(${t.smId})`),
    // A row overriding neither rung is a row that changes nothing while still
    // shadowing the sheet in every drift comparison. Clearing an override deletes
    // the row; it does not null both columns.
    check(
      'manpower_override_not_empty',
      sql`${t.tlId} IS NOT NULL OR ${t.ccmId} IS NOT NULL`,
    ),
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
