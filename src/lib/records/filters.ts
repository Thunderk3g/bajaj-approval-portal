/**
 * URL search params to a typed record filter — spec section 9.1.
 *
 * Nothing here rejects. A record grid is a place people bookmark, share and
 * hand-edit, so `?issuedFrom=yesterday` has to degrade to "no date filter"
 * rather than to a stack trace. Every field is parsed with a Zod schema whose
 * `.catch(null)` swallows the failure, which keeps the "ignore what you cannot
 * read" rule in one place instead of scattered across a dozen `try` blocks.
 *
 * Deliberately free of any database CLIENT import: this is pure string handling,
 * so it is unit-testable without a connection and cannot accidentally become the
 * place a query gets built.
 *
 * `@/db/schema/enums` is the one exception and does not weaken that. It declares
 * pgEnum values and imports nothing but `pgEnum` itself — no pool, no client, no
 * table definitions — so it costs no connection. Importing it from the narrow
 * path rather than the `@/db/schema` barrel is what keeps that true: the barrel
 * pulls in every table in the application.
 */

import { z } from 'zod';
import { correctionStatusEnum } from '@/db/schema/enums';
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

/**
 * Every status a correction can hold, derived from the enum rather than listed.
 *
 * It WAS a hand-written list of four, and it silently stopped being complete the
 * moment the verifier stage added VERIFIED and WITHDRAWN. Because the Zod schema
 * below validates against this same array with `.catch(null)`, the effect was
 * not a missing dropdown option but a filter that could not be reached at all:
 * even a hand-typed `?correctionStatus=VERIFIED` was dropped, so "records whose
 * correction is sitting with an approver" was unaskable.
 *
 * Deriving it is the fix, not adding the two missing values. `admin/corrections`
 * already does exactly this, and a list that has to be updated by hand when the
 * enum changes will fall behind the enum again.
 */
export const CORRECTION_STATUSES = correctionStatusEnum.enumValues;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];

/**
 * Roles allowed to narrow the grid to one rep.
 *
 * A rep filter only makes sense for someone whose scope holds more than one rep,
 * and it is only safe for someone whose scope the query already bounds. Both are
 * true of a TL and an ACM: `scopedRecordCondition` resolves their whole team, and
 * `recordWhere` ANDs this filter with it — so `?smId=` can narrow their team and
 * can never reach outside it. A sales user is excluded because for them it is
 * meaningless, not because it would be dangerous.
 */
const SM_ID_FILTER_ROLES: readonly Role[] = ['admin', 'tl', 'acm'];

/**
 * Roles allowed to narrow the grid to one team.
 *
 * The same reasoning as `SM_ID_FILTER_ROLES`, one rung up: only somebody whose
 * scope spans several TEAMS can ask "just this team", and it is only safe for
 * somebody `recordWhere` already bounds. An ACM qualifies on both counts. A TL
 * does not qualify on the first — they lead exactly one team, so filtering their
 * own grid by team leader is either a no-op or an empty list, and offering it
 * would suggest they can reach a team they cannot. A sales user is excluded for
 * the same reason they are excluded from `smId`.
 */
const TL_ID_FILTER_ROLES: readonly Role[] = ['admin', 'acm'];

export type RecordFilters = {
  q: string | null;
  batchId: string | null;
  /** Admin, TL and ACM only. Null for every other role — see `parseRecordFilters`. */
  smId: string | null;
  /** Admin and ACM only — the team leader drill-down. Null for everyone else. */
  tlId: string | null;
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
  tlId: null,
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
  tlId: text(64),
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
 * The `SM_ID` filter is restricted to the roles that scope more than one rep
 * (section 9.1). Dropping it here rather than in the query is the readable half
 * of the defence; the load-bearing half is that `recordWhere` ANDs every filter
 * with `scopedRecordCondition`, so even if this function were bypassed entirely
 * a sales user's `?smId=SOMEONE_ELSE` could only ever narrow their own book to
 * nothing — never widen it. The same holds for a TL naming a rep in another team.
 */
export function parseRecordFilters(
  params: SearchParams,
  viewer: { role: Role },
): RecordFilters {
  const read = <T>(schema: { parse: (v: unknown) => T }, key: string): T =>
    schema.parse(first(params[key]));

  const status = read(SCHEMA.status, 'status');
  const smId = SM_ID_FILTER_ROLES.includes(viewer.role) ? read(SCHEMA.smId, 'smId') : null;
  const tlId = TL_ID_FILTER_ROLES.includes(viewer.role) ? read(SCHEMA.tlId, 'tlId') : null;

  return {
    q: read(SCHEMA.q, 'q'),
    batchId: read(SCHEMA.batchId, 'batchId'),
    // Uppercased to match the CHECK constraint on sales_record.sm_id: a
    // lowercase filter value would silently match nothing at all.
    smId: smId ? smId.toUpperCase() : null,
    // Same reason: the roster stores tl_id uppercase, and `teamSmIds` compares
    // it verbatim — a lowercase code would resolve to an empty team.
    tlId: tlId ? tlId.toUpperCase() : null,
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
    filters.tlId !== null ||
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
    tlId: filters.tlId ?? '',
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
  'tlId',
  'status',
  'issuedFrom',
  'issuedTo',
  'gap',
  'hasCorrections',
  'correctionStatus',
] as const;
