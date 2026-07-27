/**
 * URL search params to a typed record filter — spec section 9.1.
 *
 * Nothing here rejects. A record grid is a place people bookmark, share and
 * hand-edit, so `?issuedFrom=yesterday` has to degrade to "no date filter"
 * rather than to a stack trace. Every field is parsed with a Zod schema whose
 * `.catch(null)` swallows the failure, which keeps the "ignore what you cannot
 * read" rule in one place instead of scattered across a dozen `try` blocks.
 *
 * Deliberately free of any database import: this is pure string handling, so it
 * is unit-testable without a connection and cannot accidentally become the
 * place a query gets built.
 */

import { z } from 'zod';
import { GAP_TYPES } from '@/lib/records/gaps';
import type { Role } from '@/lib/auth/rbac';

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Sortable columns, as a closed list.
 *
 * `?sort=` names a column that is interpolated into an ORDER BY, so an open
 * list would be an injection surface. The map from key to column lives in
 * query.ts; this list is what makes the lookup total.
 */
export const SORT_KEYS = [
  'appsNo',
  'policyNo',
  'clientName',
  'smId',
  'smName',
  'loginDate',
  'issuedDate',
  'fp',
  'anp',
  'status',
  'updatedAt',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export type SortDir = 'asc' | 'desc';

export const DEFAULT_SORT: SortKey = 'issuedDate';
export const DEFAULT_DIR: SortDir = 'desc';

/**
 * `ANY` is the sales rep's actual worklist filter — "show me the rows I have to
 * fix" — while the three named types split that queue by what is missing.
 */
export const GAP_FILTERS = ['ANY', ...GAP_TYPES] as const;
export type GapFilter = (typeof GAP_FILTERS)[number];

export const CORRECTION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'RETURNED'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

export type RecordFilters = {
  q: string | null;
  batchId: string | null;
  /** Admin only. Null for every other role — see `parseRecordFilters`. */
  smId: string | null;
  status: string | null;
  issuedFrom: string | null;
  issuedTo: string | null;
  gap: GapFilter | null;
  hasCorrections: boolean | null;
  correctionStatus: CorrectionStatus | null;
  sort: SortKey;
  dir: SortDir;
};

export const EMPTY_FILTERS: RecordFilters = Object.freeze({
  q: null,
  batchId: null,
  smId: null,
  status: null,
  issuedFrom: null,
  issuedTo: null,
  gap: null,
  hasCorrections: null,
  correctionStatus: null,
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIR,
});

/** Repeated params (`?status=A&status=B`) collapse to the first — a filter is single-valued. */
function first(value: string | string[] | undefined): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A bounded, trimmed, non-empty string or nothing.
 *
 * The length cap is not cosmetic: `q` becomes an `ILIKE '%…%'` pattern, and an
 * unbounded term from a crafted URL is a cheap way to make the database do
 * expensive work on every row.
 */
const text = (max: number) => z.string().trim().min(1).max(max).nullable().catch(null);

const uuid = z.uuid().nullable().catch(null);
const isoDate = z.iso.date().nullable().catch(null);
const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .nullable()
  .catch(null);

const SCHEMA = {
  q: text(120),
  batchId: uuid,
  smId: text(64),
  status: text(64),
  issuedFrom: isoDate,
  issuedTo: isoDate,
  gap: z.enum(GAP_FILTERS).nullable().catch(null),
  hasCorrections: flag,
  correctionStatus: z.enum(CORRECTION_STATUSES).nullable().catch(null),
  sort: z.enum(SORT_KEYS).catch(DEFAULT_SORT),
  dir: z.enum(['asc', 'desc'] as const).catch(DEFAULT_DIR),
};

/**
 * @param viewer the *session* role, never a request parameter.
 *
 * The `SM_ID` filter is Admin-only (section 9.1). Dropping it here rather than
 * in the query is the readable half of the defence; the load-bearing half is
 * that `recordWhere` ANDs every filter with `scopedRecordCondition`, so even if
 * this function were bypassed entirely a sales user's `?smId=SOMEONE_ELSE`
 * could only ever narrow their own book to nothing — never widen it.
 */
export function parseRecordFilters(
  params: SearchParams,
  viewer: { role: Role },
): RecordFilters {
  const read = <T>(schema: { parse: (v: unknown) => T }, key: string): T =>
    schema.parse(first(params[key]));

  const status = read(SCHEMA.status, 'status');
  const smId = viewer.role === 'admin' ? read(SCHEMA.smId, 'smId') : null;

  return {
    q: read(SCHEMA.q, 'q'),
    batchId: read(SCHEMA.batchId, 'batchId'),
    // Uppercased to match the CHECK constraint on sales_record.sm_id: a
    // lowercase filter value would silently match nothing at all.
    smId: smId ? smId.toUpperCase() : null,
    status: status ? status.toUpperCase() : null,
    issuedFrom: read(SCHEMA.issuedFrom, 'issuedFrom'),
    issuedTo: read(SCHEMA.issuedTo, 'issuedTo'),
    gap: read(SCHEMA.gap, 'gap'),
    hasCorrections: read(SCHEMA.hasCorrections, 'hasCorrections'),
    correctionStatus: read(SCHEMA.correctionStatus, 'correctionStatus'),
    sort: read(SCHEMA.sort, 'sort'),
    dir: read(SCHEMA.dir, 'dir'),
  };
}

/** True when anything beyond sort order is narrowing the list — drives the "Clear" affordance. */
export function hasActiveFilters(filters: RecordFilters): boolean {
  return (
    filters.q !== null ||
    filters.batchId !== null ||
    filters.smId !== null ||
    filters.status !== null ||
    filters.issuedFrom !== null ||
    filters.issuedTo !== null ||
    filters.gap !== null ||
    filters.hasCorrections !== null ||
    filters.correctionStatus !== null
  );
}

/** The form control values for a parsed filter set — empty string is "unset" in a `<select>`. */
export function filterFormValues(filters: RecordFilters): Record<string, string> {
  return {
    q: filters.q ?? '',
    batchId: filters.batchId ?? '',
    smId: filters.smId ?? '',
    status: filters.status ?? '',
    issuedFrom: filters.issuedFrom ?? '',
    issuedTo: filters.issuedTo ?? '',
    gap: filters.gap ?? '',
    hasCorrections: filters.hasCorrections === null ? '' : String(filters.hasCorrections),
    correctionStatus: filters.correctionStatus ?? '',
    sort: filters.sort,
    dir: filters.dir,
  };
}

export const FILTER_KEYS = [
  'q',
  'batchId',
  'smId',
  'status',
  'issuedFrom',
  'issuedTo',
  'gap',
  'hasCorrections',
  'correctionStatus',
] as const;
