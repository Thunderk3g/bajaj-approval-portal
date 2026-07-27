/**
 * Every read of `sales_record` in the application goes through this module.
 *
 * The point is structural, not stylistic (spec section 4.1). `recordWhere` is
 * the only function that assembles a WHERE clause for the record table, and its
 * first element is always `scopedRecordCondition(viewer)`. Because it is
 * unconditionally first and every exported query calls it, there is no code
 * path that produces an unscoped record query — a future refactor would have to
 * delete the seed line to break scoping, and the integration tests fail loudly
 * when that happens.
 *
 * Money columns (`fp`, `anp`) are numeric(18,2) and arrive from node-postgres as
 * strings. They are never parsed here; doing so would reintroduce the float
 * drift the column type exists to prevent.
 */

import { and, asc, count, eq, exists, gte, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { correctionRequest, salesRecord, uploadBatch } from '@/db/schema';
import { scopedRecordCondition, type SessionUser } from '@/lib/auth/rbac';
import { ISSUED_STATUS } from '@/lib/records/gaps';
import type { PageParams } from '@/lib/pagination';
import {
  EMPTY_FILTERS,
  type CorrectionStatus,
  type GapFilter,
  type RecordFilters,
  type SortKey,
} from './filters';

/* --------------------------------------------------------------- predicates */

/**
 * The characters `String.prototype.trim()` removes.
 *
 * `btrim` defaults to spaces only, which would make the SQL gap filter disagree
 * with `detectGaps` on a value padded with a tab or a non-breaking space — the
 * exact kind of near-miss that makes the grid claim a rep has work they do not.
 * Passed as a bound parameter rather than inlined, so no escaping is involved.
 */
const JS_TRIM_CHARS = String.fromCodePoint(
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
);

/** Mirrors `isBlank` in gaps.ts: null, or nothing but whitespace. */
function isBlankSql(column: PgColumn): SQL {
  return sql`(${column} is null or btrim(${column}, ${JS_TRIM_CHARS}) = '')`;
}

/** Mirrors the `status === ISSUED` guard in `detectGaps` — case- and padding-insensitive. */
const isIssuedSql: SQL = sql`upper(btrim(coalesce(${salesRecord.status}, ''), ${JS_TRIM_CHARS})) = ${ISSUED_STATUS}`;

/**
 * The SQL expression of the status-conditional gap rule (spec section 6.4).
 *
 * Exported so `tests/integration/records-gaps.test.ts` can assert it selects
 * exactly the rows `detectGaps` flags. If the two drift, the grid and the
 * dashboard report different workloads and the UI is simply lying about how
 * much there is to fix.
 */
export function gapCondition(gap: GapFilter): SQL {
  // issued_date is a `date` column, so "blank" can only mean NULL — there is no
  // empty-string state for it to be in.
  const missingIssuedDate = sql`${salesRecord.issuedDate} is null`;
  const missingPolicyNo = isBlankSql(salesRecord.policyNo);
  const missingAutopay = isBlankSql(salesRecord.autopay);

  const missing =
    gap === 'MISSING_ISSUED_DATE'
      ? missingIssuedDate
      : gap === 'MISSING_POLICY_NO'
        ? missingPolicyNo
        : gap === 'MISSING_AUTOPAY'
          ? missingAutopay
          : sql`(${missingIssuedDate} or ${missingPolicyNo} or ${missingAutopay})`;

  return sql`(${isIssuedSql} and ${missing})`;
}

/**
 * Escapes a user's term before it becomes an `ILIKE '%…%'` pattern.
 *
 * Without this, a search for `%` matches every row and a search for `_` matches
 * any single character — the term would be read as a pattern rather than as
 * text, which is both wrong and a way to force a full scan on demand.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Free-text search across the four trigram-indexed columns plus `extra`.
 *
 * `ILIKE '%term%'` rather than the `%` similarity operator because the GIN
 * indexes in drizzle/custom/0000_trigram_indexes.sql are `gin_trgm_ops`, which
 * serves substring LIKE/ILIKE directly — and substring is what "find
 * application 6167509575" actually means.
 *
 * `extra` is the knowing exception: its index is a plain jsonb GIN, which
 * answers containment and key existence, not substring, so the cast to text
 * cannot be index-assisted. Spec section 9.1 requires `extra` to be searchable
 * and the table is a few thousand rows, so the scan is accepted rather than the
 * requirement dropped. The summary records the `extra::text` trigram index that
 * would remove it.
 */
function searchCondition(term: string): SQL {
  const pattern = likePattern(term);
  return sql`(
    ${salesRecord.appsNo} ilike ${pattern}
    or ${salesRecord.policyNo} ilike ${pattern}
    or ${salesRecord.clientName} ilike ${pattern}
    or ${salesRecord.smName} ilike ${pattern}
    or ${salesRecord.extra}::text ilike ${pattern}
  )`;
}

/** EXISTS rather than a join: a record with three PENDING requests is still one row. */
function correctionStatusCondition(status: CorrectionStatus): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(correctionRequest)
      .where(
        and(
          eq(correctionRequest.recordId, salesRecord.id),
          eq(correctionRequest.status, status),
        ),
      ),
  );
}

/**
 * THE where-clause builder. Scoping is element zero, unconditionally.
 *
 * `and()` drops undefined entries, so an admin — for whom
 * `scopedRecordCondition` returns undefined — simply gets the filters. A sales
 * user's `sm_id = …` can never be omitted by a filter combination, because no
 * filter can remove an element from this array.
 */
function recordWhere(viewer: SessionUser, filters: RecordFilters): SQL | undefined {
  const conditions: Array<SQL | undefined> = [scopedRecordCondition(viewer)];

  if (filters.q) conditions.push(searchCondition(filters.q));
  if (filters.batchId) conditions.push(eq(salesRecord.sourceBatchId, filters.batchId));
  if (filters.smId) conditions.push(eq(salesRecord.smId, filters.smId));
  if (filters.status) conditions.push(eq(salesRecord.status, filters.status));
  if (filters.issuedFrom) conditions.push(gte(salesRecord.issuedDate, filters.issuedFrom));
  if (filters.issuedTo) conditions.push(lte(salesRecord.issuedDate, filters.issuedTo));
  if (filters.gap) conditions.push(gapCondition(filters.gap));
  if (filters.hasCorrections !== null) {
    conditions.push(eq(salesRecord.hasCorrections, filters.hasCorrections));
  }
  if (filters.correctionStatus) {
    conditions.push(correctionStatusCondition(filters.correctionStatus));
  }

  return and(...conditions);
}

/**
 * The scoped predicate on its own, for queries that join `sales_record` from
 * another table (the version chain). Same seed, same guarantee.
 */
export function scopedRecordWhere(viewer: SessionUser): SQL | undefined {
  return recordWhere(viewer, EMPTY_FILTERS);
}

/* ------------------------------------------------------------------ sorting */

const SORT_COLUMNS: Record<SortKey, PgColumn> = {
  appsNo: salesRecord.appsNo,
  policyNo: salesRecord.policyNo,
  clientName: salesRecord.clientName,
  smId: salesRecord.smId,
  smName: salesRecord.smName,
  loginDate: salesRecord.loginDate,
  issuedDate: salesRecord.issuedDate,
  fp: salesRecord.fp,
  anp: salesRecord.anp,
  status: salesRecord.status,
  updatedAt: salesRecord.updatedAt,
};

/**
 * Sort column, then `apps_no` as a tiebreaker — always.
 *
 * Offset pagination over a non-total order is not merely untidy: Postgres may
 * return ties in a different order per query, so one row can appear on page 2
 * and again on page 3 while another is never shown at all. `apps_no` is unique,
 * so appending it makes the order total.
 *
 * NULLS LAST because a null sort key means "not applicable yet" — the PENDING
 * applications with no issued date are not what someone sorting by issuance
 * date is looking for.
 */
function orderByFor(filters: RecordFilters) {
  const column = SORT_COLUMNS[filters.sort];
  const primary =
    filters.dir === 'asc' ? sql`${column} asc nulls last` : sql`${column} desc nulls last`;
  return [primary, asc(salesRecord.appsNo)];
}

/* ------------------------------------------------------------------ queries */

const LIST_COLUMNS = {
  id: salesRecord.id,
  appsNo: salesRecord.appsNo,
  policyNo: salesRecord.policyNo,
  clientName: salesRecord.clientName,
  smId: salesRecord.smId,
  smName: salesRecord.smName,
  loginDate: salesRecord.loginDate,
  issuedDate: salesRecord.issuedDate,
  fp: salesRecord.fp,
  anp: salesRecord.anp,
  productName: salesRecord.productName,
  status: salesRecord.status,
  status2: salesRecord.status2,
  autopay: salesRecord.autopay,
  hasCorrections: salesRecord.hasCorrections,
  currentVersion: salesRecord.currentVersion,
  updatedAt: salesRecord.updatedAt,
};

export type RecordDetailRow = typeof salesRecord.$inferSelect;
export type RecordListRow = Pick<RecordDetailRow, keyof typeof LIST_COLUMNS>;

export async function countRecords(viewer: SessionUser, filters: RecordFilters): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(salesRecord)
    .where(recordWhere(viewer, filters));
  return row?.value ?? 0;
}

export async function listRecords(
  viewer: SessionUser,
  filters: RecordFilters,
  page: PageParams,
): Promise<{ rows: RecordListRow[]; total: number }> {
  const where = recordWhere(viewer, filters);

  // The count runs against the identical predicate, so the "N records" label and
  // the rows on the page can never describe different populations.
  const [rows, total] = await Promise.all([
    db
      .select(LIST_COLUMNS)
      .from(salesRecord)
      .where(where)
      .orderBy(...orderByFor(filters))
      .limit(page.pageSize)
      .offset(page.offset),
    countRecords(viewer, filters),
  ]);

  return { rows, total };
}

/**
 * A single record by `Apps_No`, or null.
 *
 * Null rather than a thrown authorization error on purpose: the caller renders
 * `notFound()`. A 403 would confirm the application exists and belongs to
 * someone, which is itself the leak — a rep enumerating `Apps_No` values must
 * not be able to tell "not yours" apart from "not a record".
 */
export async function getRecord(
  viewer: SessionUser,
  appsNo: string,
): Promise<RecordDetailRow | null> {
  const [row] = await db
    .select()
    .from(salesRecord)
    .where(and(scopedRecordWhere(viewer), eq(salesRecord.appsNo, appsNo)))
    .limit(1);
  return row ?? null;
}

/* --------------------------------------------------------- filter dropdowns */

/** Statuses actually present in the viewer's own scope — an option that matches nothing is noise. */
export async function listStatusOptions(viewer: SessionUser): Promise<string[]> {
  const rows = await db
    .selectDistinct({ status: salesRecord.status })
    .from(salesRecord)
    .where(scopedRecordWhere(viewer))
    .orderBy(asc(salesRecord.status));
  return rows.map((r) => r.status).filter((s): s is string => Boolean(s));
}

export async function listBatchOptions(
  viewer: SessionUser,
): Promise<Array<{ id: string; label: string }>> {
  const rows = await db
    .selectDistinct({
      id: uploadBatch.id,
      fileName: uploadBatch.originalFileName,
      uploadedAt: uploadBatch.uploadedAt,
    })
    .from(salesRecord)
    .innerJoin(uploadBatch, eq(uploadBatch.id, salesRecord.sourceBatchId))
    .where(scopedRecordWhere(viewer));

  return rows
    .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
    .map((r) => ({ id: r.id, label: r.fileName }));
}

/**
 * The `SM_ID` dropdown. Admin only (section 9.1), empty for everyone else.
 *
 * A sales user must not be handed the roster of other reps' IDs: the filter
 * would not widen their scope, but the list of IDs is information they have no
 * reason to hold.
 */
export async function listSmIdOptions(
  viewer: SessionUser,
): Promise<Array<{ smId: string; smName: string | null }>> {
  if (viewer.role !== 'admin') return [];

  const rows = await db
    .selectDistinct({ smId: salesRecord.smId, smName: salesRecord.smName })
    .from(salesRecord)
    .where(scopedRecordWhere(viewer))
    .orderBy(asc(salesRecord.smId));

  // Distinct on the pair can repeat an SM_ID whose name is spelled two ways;
  // the first spelling wins so the dropdown holds one entry per rep.
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (seen.has(r.smId)) return false;
    seen.add(r.smId);
    return true;
  });
}
