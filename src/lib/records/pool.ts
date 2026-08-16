/**
 * The unassigned pool — the records parked on a bucket code, and who may claim them.
 *
 * THE SECOND SCOPING EXCEPTION, after `src/lib/corrections/lookup.ts`.
 *
 * Everywhere else a record read goes through `scopedRecordCondition`, which pins
 * a rep to their own SM_ID and a manager to their team. No bucket code is
 * anybody's team, so under strict scoping no SM, TL or ACM can see a single DIY
 * record — and the MAPPING_DIY chain exists precisely so those records can be
 * claimed. The rule and the requirement genuinely conflict, exactly as they do
 * for the lookup, and this is the second and last deliberate hole in it.
 *
 * The exception is safe because of what it is NOT:
 *
 *   1. The predicate is `sm_id IN (bucket codes)`, seeded unconditionally as
 *      element zero of `poolWhere` and unreachable by any filter. There is no
 *      query parameter that widens this to a named rep's book — a filter can
 *      only narrow what is already nobody's.
 *   2. The projection is no wider than the lookup's. See LIST_COLUMNS below.
 *   3. It is a read only. Ownership changes ride the existing correction
 *      machinery — a MAPPING/CLAIM_IN request through `submitCorrection`, which
 *      re-resolves the record itself and pins the destination to the actor's own
 *      books. Nothing here mutates, and no new mutation path was added for it.
 *
 * Widening any of the three re-opens the hole. Together with the lookup these
 * are the only two modules that may read a record outside the caller's scope,
 * and they must stay the only two.
 *
 * Concurrency is not handled here and must not be. Two reps claiming the same
 * application collide on the partial unique index
 * `correction_one_open_per_field`, which `submitCorrection` catches and reports;
 * `pendingClaim` below is what the screen shows so the second rep sees it before
 * they try, not a lock.
 */

import { and, asc, count, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { correctionRequest, period, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { Role, SessionUser } from '@/lib/auth/rbac';
import { actorBooks, LOCKING_STATUSES } from '@/lib/corrections/service';
import { resolvePeriodFilter, type PeriodFilter } from '@/lib/dashboard/performance';
import { pageCount, type PageParams } from '@/lib/pagination';
import { likePattern } from '@/lib/records/query';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';

/* ----------------------------------------------------------------- who may */

/**
 * The three rungs that can act on a claim, and nobody else.
 *
 * An admin, approver or verifier is deliberately absent. They already read every
 * record through `scopedRecordCondition` returning undefined, so a pool screen
 * would tell them nothing their own record grid does not — and none of them can
 * raise a claim, so the one action on the screen would be dead for them.
 */
const POOL_ROLES: readonly Role[] = ['sales', 'tl', 'acm'];

/**
 * Refuses before a single row is read.
 *
 * Called from inside `poolWhere`, so it guards every query in this module by
 * construction rather than by each exported function remembering to.
 */
function assertPoolRole(viewer: SessionUser): void {
  if (!POOL_ROLES.includes(viewer.role)) {
    throw new AuthzError(
      'FORBIDDEN',
      'The unassigned pool is for sales users and their managers.',
    );
  }
}

/* --------------------------------------------------------------- predicates */

/**
 * THE where-clause builder. The bucket predicate is element zero, unconditionally.
 *
 * Same structure as `recordWhere` and `leadWhere`, for the same structural
 * reason: no filter can remove an element from this array, so no combination of
 * query parameters reaches a record that belongs to somebody.
 */
function poolWhere(viewer: SessionUser, filters: PoolFilters): SQL | undefined {
  assertPoolRole(viewer);

  const conditions: Array<SQL | undefined> = [
    inArray(salesRecord.smId, PLACEHOLDER_CODE_LIST),
  ];

  if (filters.q) conditions.push(searchCondition(filters.q));
  if (filters.periodId) conditions.push(eq(salesRecord.periodId, filters.periodId));
  if (filters.issuedFrom) conditions.push(gte(salesRecord.issuedDate, filters.issuedFrom));
  if (filters.issuedTo) conditions.push(lte(salesRecord.issuedDate, filters.issuedTo));

  return and(...conditions);
}

/**
 * The three columns somebody knows an unclaimed policy by.
 *
 * Narrower than the record grid's search on purpose: `policy_no` and `sm_name`
 * are not in the projection, and a term that matches a column the screen does
 * not show reads as a broken filter. `likePattern` is imported rather than
 * restated — a second copy of that escaping rule is a second place for a bare
 * `%` to turn the search box into a full scan on demand.
 */
function searchCondition(term: string): SQL {
  const pattern = likePattern(term);
  return sql`(
    ${salesRecord.appsNo} ilike ${pattern}
    or ${salesRecord.clientName} ilike ${pattern}
    or ${salesRecord.location} ilike ${pattern}
  )`;
}

/**
 * The one open claim on this record's ownership, or no row.
 *
 * A LEFT JOIN rather than the EXISTS the record grid uses, and it cannot
 * multiply a row: `correction_one_open_per_field` is UNIQUE on
 * `(record_id, field_name)` across exactly these three statuses, so this join
 * matches at most once. What the join buys over EXISTS is the request itself —
 * "is one open" alone cannot say whether it is the viewer's or point at it.
 *
 * `field_name = 'smId'` is what keeps an unrelated open correction — an autopay
 * flag, an issuance date — from badging the row as claimed.
 */
function openClaimJoin(): SQL {
  return and(
    eq(correctionRequest.recordId, salesRecord.id),
    eq(correctionRequest.fieldName, 'smId'),
    inArray(correctionRequest.status, [...LOCKING_STATUSES]),
  ) as SQL;
}

/**
 * Whether a claim may be raised at all, mirroring `assertPeriodOpen` exactly.
 *
 * A record with no period passes — null means "imported before the portal
 * tracked cycles", not "in a cycle that might be closed" — and the trigger in
 * `0005_periods.sql` reads it the same way. Two spellings of that rule is how
 * the screen offers a button the insert then refuses.
 */
const PERIOD_OPEN = sql<boolean>`(${salesRecord.periodId} is null or ${period.status} = 'OPEN')`;

/* ------------------------------------------------------------------ filters */

export type SearchParams = Record<string, string | string[] | undefined>;

export type PoolFilters = {
  q: string | null;
  issuedFrom: string | null;
  issuedTo: string | null;
  /** Resolved from `?period=` by `resolvePeriodFilter`; null is every cycle. */
  periodId: string | null;
};

export const EMPTY_POOL_FILTERS: PoolFilters = Object.freeze({
  q: null,
  issuedFrom: null,
  issuedTo: null,
  periodId: null,
});

/** Repeated params (`?q=a&q=b`) collapse to the first — a filter is single-valued. */
function first(value: string | string[] | undefined): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Nothing here rejects — the same contract as `records/filters.ts`.
 *
 * A pool URL is bookmarked, shared and hand-edited, so `?issuedFrom=yesterday`
 * degrades to "no date filter" rather than to a stack trace. Every field is
 * parsed by a schema whose `.catch(null)` swallows the failure.
 *
 * The length cap on `q` is not cosmetic: it becomes an `ILIKE '%…%'`, and an
 * unbounded term from a crafted URL is a cheap way to make the database work.
 */
const SCHEMA = {
  q: z.string().trim().min(1).max(120).nullable().catch(null),
  isoDate: z.iso.date().nullable().catch(null),
  period: z.string().trim().max(16).catch(''),
};

/**
 * Async because the period filter resolves against the period table.
 *
 * Returns the resolved `PeriodFilter` alongside the query filters so the screen
 * gets the dropdown options and the code to echo back without asking twice. The
 * default is the OPEN cycle — the month somebody is actually reconciling — which
 * is `resolvePeriodFilter`'s own default, reused rather than restated.
 */
export async function parsePoolFilters(
  params: SearchParams,
): Promise<{ filters: PoolFilters; period: PeriodFilter }> {
  const resolved = await resolvePeriodFilter(SCHEMA.period.parse(first(params.period)));

  return {
    filters: {
      q: SCHEMA.q.parse(first(params.q)),
      issuedFrom: SCHEMA.isoDate.parse(first(params.issuedFrom)),
      issuedTo: SCHEMA.isoDate.parse(first(params.issuedTo)),
      periodId: resolved.periodId,
    },
    period: resolved,
  };
}

/** True when anything is narrowing the list — drives the "Clear" affordance. */
export function hasActivePoolFilters(filters: PoolFilters): boolean {
  return filters.q !== null || filters.issuedFrom !== null || filters.issuedTo !== null;
}

/* ------------------------------------------------------------------ reading */

/**
 * The permitted fields — no wider than the lookup exception's six.
 *
 * `policy_no`, `fp`, `anp` and `lead_id` are DELIBERATELY absent. A record in the
 * pool belongs to nobody, so the whole portal's population of them is readable
 * here by every rep at once; that is tolerable for what a claimant needs to
 * recognise a sale (whose it is, what it is, when it issued, where) and is not
 * tolerable for premium figures or for a policy number, which is a second
 * identifier into systems this portal does not own. `location` earns its place
 * where a policy number does not: it is how a rep tells their own branch's
 * digital business from another city's.
 */
const LIST_COLUMNS = {
  appsNo: salesRecord.appsNo,
  clientName: salesRecord.clientName,
  productName: salesRecord.productName,
  status: salesRecord.status,
  issuedDate: salesRecord.issuedDate,
  location: salesRecord.location,
  /**
   * Which bucket the record sits in. Typed `string` rather than the two-code
   * union because `PLACEHOLDER_CODE_LIST` is the authority on that list and is
   * not a const tuple; `BUCKET_LABELS` below falls back rather than assuming.
   */
  bucket: salesRecord.smId,
  periodOpen: PERIOD_OPEN,
  claimId: correctionRequest.id,
  claimSubmittedBy: correctionRequest.submittedBy,
  claimSmId: correctionRequest.smId,
};

export type PoolRow = {
  appsNo: string;
  clientName: string | null;
  productName: string | null;
  status: string | null;
  issuedDate: string | null;
  location: string | null;
  bucket: string;
  /** False means the record's cycle is closed: no claim can be raised on it. */
  periodOpen: boolean;
  /**
   * An ownership claim already in flight, or null.
   *
   * `requestId` is populated ONLY when the claim is the viewer's. Somebody
   * else's claim is reported as its bare existence — no claimant name, no
   * request id, nothing that says who is competing for the sale.
   */
  pendingClaim: { mine: boolean; requestId: string | null } | null;
};

/** What each bucket code means, for a screen that must never print the code itself. */
export const BUCKET_LABELS: Record<string, string> = {
  DIY: 'Digital (DIY)',
  '111222-UN': 'Unassigned',
};

export function bucketLabel(bucket: string): string {
  return BUCKET_LABELS[bucket] ?? bucket;
}

/**
 * Newest issuance first, `apps_no` as the tiebreaker — always.
 *
 * The tiebreaker makes the order total. `issued_date` holds one value across
 * many rows, and offset pagination over a non-total order lets Postgres return
 * ties differently per query: one application appears on page 2 and again on
 * page 3 while another is never shown at all. NULLS LAST because a record with
 * no issuance date is not the newest one in the pool.
 */
const ORDER_BY = [sql`${salesRecord.issuedDate} desc nulls last`, asc(salesRecord.appsNo)];

/**
 * Every SM_ID this viewer may act for — the set that makes a claim "mine".
 *
 * `actorBooks` is the same function `submitCorrection` authorizes the
 * destination with, so "mine" on this screen means exactly "a claim I could have
 * raised". A misconfigured account (a rep with no SM_ID, a TL with no code)
 * resolves to no books rather than throwing: they can read the pool, and the
 * submit path is where their configuration problem is explained.
 */
async function booksOf(viewer: SessionUser): Promise<string[]> {
  const scope = await actorBooks(viewer);
  return scope.ok ? scope.books.smIds : [];
}

export async function countPool(viewer: SessionUser, filters: PoolFilters): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(salesRecord)
    .where(poolWhere(viewer, filters));
  return row?.value ?? 0;
}

export async function listPool(
  viewer: SessionUser,
  filters: PoolFilters,
  page: PageParams,
): Promise<{
  rows: PoolRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}> {
  const where = poolWhere(viewer, filters);

  // The count runs against the identical predicate, so the "N records" label and
  // the rows beneath it can never describe different populations.
  const [rows, total, books] = await Promise.all([
    db
      .select(LIST_COLUMNS)
      .from(salesRecord)
      // Both joins are projection only — neither appears in `where` — so the
      // count above needs neither, and a record whose period row was deleted
      // still lists rather than vanishing.
      .leftJoin(period, eq(period.id, salesRecord.periodId))
      .leftJoin(correctionRequest, openClaimJoin())
      .where(where)
      .orderBy(...ORDER_BY)
      .limit(page.pageSize)
      .offset(page.offset),
    countPool(viewer, filters),
    booksOf(viewer),
  ]);

  return {
    rows: rows.map((row) => ({
      appsNo: row.appsNo,
      clientName: row.clientName,
      productName: row.productName,
      status: row.status,
      issuedDate: row.issuedDate,
      location: row.location,
      bucket: row.bucket,
      periodOpen: row.periodOpen,
      pendingClaim: row.claimId
        ? mineOrNot(row.claimId, row.claimSubmittedBy, row.claimSmId, viewer, books)
        : null,
    })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: pageCount(total, page.pageSize),
  };
}

/**
 * A claim is the viewer's when they raised it OR when it lands in their books.
 *
 * Both halves are needed and neither implies the other: a rep's own claim was
 * raised by them, but the claim their TL raised on their behalf was not — and it
 * is still the claim that decides whether that rep may raise another. The
 * mapping is the other way for the manager: they raised it, and it is destined
 * for one of their people rather than for them.
 */
function mineOrNot(
  requestId: string,
  // Nullable because the LEFT JOIN makes every claim column nullable to the type
  // system. They are non-null whenever `requestId` is, which is the only way
  // this is reached; a null therefore fails both halves and reads as "not mine",
  // which is the safe direction for a badge that gates a link.
  submittedBy: string | null,
  bookSmId: string | null,
  viewer: SessionUser,
  books: string[],
): { mine: boolean; requestId: string | null } {
  const mine = submittedBy === viewer.id || (bookSmId !== null && books.includes(bookSmId));
  return { mine, requestId: mine ? requestId : null };
}

/* ------------------------------------------------------------------ summary */

export type PoolSummary = {
  /** Everything in the pool the viewer may see — which is all of it. */
  total: number;
  /** No claim open and the cycle is open: a button would work today. */
  claimable: number;
  /** A claim already in flight, whoever raised it. */
  claimed: number;
  /** …of which are the viewer's own. */
  mine: number;
};

/**
 * The stat cards, every counter computed over the unfiltered pool.
 *
 * Conditional aggregates over one scan of the same seed predicate the list uses.
 * One query per counter would let the headline numbers describe a different
 * population than the rows beneath them the moment a claim lands between the
 * two — and a claim landing mid-page-load is the normal case on a screen several
 * reps are working at once, not the exotic one.
 */
export async function poolSummary(viewer: SessionUser): Promise<PoolSummary> {
  const books = await booksOf(viewer);
  const where = poolWhere(viewer, EMPTY_POOL_FILTERS);

  // `inArray` refuses an empty list, and a viewer with no books is a real state
  // (a rep whose account has no SM_ID). Their own submissions still count.
  const isMine = books.length
    ? sql`(${correctionRequest.submittedBy} = ${viewer.id} or ${inArray(correctionRequest.smId, books)})`
    : sql`${correctionRequest.submittedBy} = ${viewer.id}`;

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      claimable: sql<number>`(count(*) filter (
        where ${correctionRequest.id} is null and ${PERIOD_OPEN}
      ))::int`,
      claimed: sql<number>`(count(*) filter (where ${correctionRequest.id} is not null))::int`,
      mine: sql<number>`(count(*) filter (
        where ${correctionRequest.id} is not null and ${isMine}
      ))::int`,
    })
    .from(salesRecord)
    .leftJoin(period, eq(period.id, salesRecord.periodId))
    .leftJoin(correctionRequest, openClaimJoin())
    .where(where);

  return {
    total: row?.total ?? 0,
    claimable: row?.claimable ?? 0,
    claimed: row?.claimed ?? 0,
    mine: row?.mine ?? 0,
  };
}
