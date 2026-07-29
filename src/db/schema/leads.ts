import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { period } from './periods';
import { uploadBatch } from './records';
import { user } from './auth';

/**
 * Leads and ingestion jobs — 2026-07-28 ingestion-service spec.
 *
 * These two tables are written by the PYTHON ingestion service, not by this
 * application, but they are declared here because Drizzle migrations remain the
 * single source of truth for schema. The service runs no DDL; it validates on
 * startup that every column it writes exists and refuses to start otherwise.
 *
 * Generating one language's definitions from the other was considered and
 * rejected: a generator is a third thing to keep correct, and the failure it
 * prevents (drift) is already caught loudly at service startup.
 */

export const ingestJobKindEnum = pgEnum('ingest_job_kind', ['PARSE', 'LEADS', 'PROOF']);

export const ingestJobStatusEnum = pgEnum('ingest_job_status', [
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
]);

/**
 * One row per unit of background work.
 *
 * A table rather than an in-memory future, deliberately. A service restart
 * mid-parse must leave the job visibly FAILED; an in-memory job would simply
 * vanish, and the admin would be left watching a spinner for a worker that no
 * longer exists. `heartbeatAt` is what makes that detectable — a RUNNING row
 * whose heartbeat has gone stale was orphaned, and startup reaps it.
 */
export const ingestJob = pgTable(
  'ingest_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: ingestJobKindEnum('kind').notNull(),
    status: ingestJobStatusEnum('status').notNull().default('QUEUED'),
    batchId: uuid('batch_id').references(() => uploadBatch.id, { onDelete: 'cascade' }),
    /** Human-readable phase, e.g. "streaming Lead Dump". Shown verbatim in the UI. */
    stage: text('stage'),
    /**
     * Progress as a fraction. `total` is null while it is genuinely unknown —
     * Lead Dump's row count cannot be known before streaming it, and a made-up
     * denominator produces a progress bar that lies.
     */
    done: integer('done').notNull().default(0),
    total: integer('total'),
    result: jsonb('result'),
    /** Operator-facing message. Never contains cell values — see spec section 8. */
    error: text('error'),
    requestedBy: text('requested_by').references(() => user.id),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ingest_job_batch_idx').on(t.batchId, t.createdAt),
    index('ingest_job_status_idx').on(t.status, t.heartbeatAt),
  ],
);

/**
 * A lead from the `Lead Dump` sheet — spec section 6.
 *
 * Leads deliberately do NOT join to `sales_record`. The sheet carries no
 * `Apps_No`, so there is no key to join on, and a synthetic link would be a
 * claim the data does not support. A lead is a parallel, read-only view scoped
 * by `sm_code`: a rep sees their own, and that is all it is for. Leads are not
 * correctable, do not enter the verifier queue, and do not participate in the
 * monthly close.
 */
export const lead = pgTable(
  'lead',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The sheet's own identifier, and the natural key. Text rather than numeric
     * for the same reason `apps_no` is: it reads as 105683457.0 and must never
     * render as 1.05683457e+08.
     */
    leadNo: text('lead_no').notNull().unique(),
    /**
     * The attribution key. Same identifier family as `sales_record.sm_id`
     * (ICCS427343 against ICCSP90766), uppercased on the same reasoning: six
     * reps appear in both cases in the source, and without normalising each
     * would see half their own leads.
     *
     * Nullable, and `111222-UN` is a real value meaning "not given to anyone
     * yet" — see `isUnassigned` below.
     */
    smCode: text('sm_code'),
    smName: text('sm_name'),
    tlName: text('tl_name'),
    ccmName: text('ccm_name'),
    ccmCode: text('ccm_code'),
    location: text('location'),
    /** The sheet carries `Location` twice and the two are not always equal. */
    locationAlt: text('location_alt'),
    registerDate: date('register_date'),
    source: text('source'),
    productType: text('product_type'),
    productMix: text('product_mix'),
    prodId: text('prod_id'),
    savingFlag: text('saving_flag'),
    /**
     * Denormalised from `sm_code` at write time rather than computed per query.
     *
     * Three places ask "is this lead owned" — the rep's scoped list, the admin's
     * unassigned pool, and the attribution counters — and a partial index on
     * this column serves all three. Recomputing the sentinel comparison in each
     * would be three chances to spell it differently.
     */
    isUnassigned: boolean('is_unassigned').notNull().default(false),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    sourceBatchId: uuid('source_batch_id').references(() => uploadBatch.id),
    periodId: uuid('period_id').references(() => period.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Mirrors sales_record's constraint. A lead keyed by a lowercase code would
    // never join to the rep it belongs to.
    check('lead_sm_code_uppercase', sql`${t.smCode} IS NULL OR ${t.smCode} = upper(${t.smCode})`),
    index('lead_sm_code_idx').on(t.smCode),
    index('lead_batch_idx').on(t.sourceBatchId),
    index('lead_register_date_idx').on(t.registerDate),
    index('lead_unassigned_idx').on(t.isUnassigned),
  ],
);
