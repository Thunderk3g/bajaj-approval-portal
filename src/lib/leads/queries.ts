/**
 * Every read of `lead` in the application goes through this module.
 *
 * The table is written by the Python ingestion service and never by this app, so
 * everything here is a read — but the read is the security boundary, and the
 * point is structural rather than stylistic. `leadWhere` is the only function
 * that assembles a WHERE clause for the table, and its first element is always
 * `scopedLeadCondition(viewer)`, exactly as `recordWhere` seeds itself with
 * `scopedRecordCondition`. No filter can remove an element from that array, so
 * there is no combination of query parameters that widens a rep's view; a future
 * refactor would have to delete the seed line to break it, and
 * tests/integration/leads-scope.test.ts fails loudly when that happens.
 *
 * Nothing here joins to `sales_record`, and nothing should. `Lead Dump` carries
 * no `Apps_No` (spec 6.3), so any link between a lead and an application would
 * be invented rather than observed. Leads are a parallel, read-only view.
 */

import { and, asc, count, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { lead, manpower } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import { GLOBAL_READ_ROLES, teamSmIds, type SessionUser } from '@/lib/auth/rbac';
import { pageCount, type PageParams } from '@/lib/pagination';
import { likePattern } from '@/lib/records/query';
import { EMPTY_LEAD_FILTERS, type LeadFilters } from './filters';

/* --------------------------------------------------------------- predicates */

/**
 * The only sanctioned way to scope lead reads — the mirror of
 * `scopedRecordCondition`, keyed on `sm_code` instead of `sm_id`.
 *
 * Admins, approvers and verifiers see everything (`GLOBAL_READ_ROLES`). A sales
 * user is confined to their own SM_ID; a team leader or area manager to the reps
 * beneath them, through the same `teamSmIds` subquery `scopedRecordCondition`
 * uses. Every non-global role throws when its scoping code is missing rather than
 * returning undefined: "no condition" means "no filter", which would turn a
 * single misconfigured account into one that reads every rep's leads.
 *
 * The two manager rungs are handled here rather than left to fall through to the
 * SM_ID branch. They have no `sm_id` at all, so the fall-through refused them
 * with "Sales user has no SM_ID" — a message about a role they do not hold, on a
 * screen they are entitled to. It went unnoticed while the portal had no manager
 * accounts; the provisioning worklist now creates them by the dozen.
 *
 * The unassigned pool is excluded here structurally rather than left to the
 * sentinel to exclude itself. `111222-UN` does not collide with any real code
 * today, but that is an accident of what the workbook happens to write; leads
 * waiting for an owner belong on the admin's reassignment list, not in whichever
 * rep's book the next sentinel spelling happens to land in.
 */
export function scopedLeadCondition(viewer: SessionUser): SQL | undefined {
  if (GLOBAL_READ_ROLES.includes(viewer.role)) return undefined;

  if (viewer.role === 'tl') {
    if (!viewer.tlCode) throw new AuthzError('FORBIDDEN', 'TL user has no TL code');
    return and(
      sql`${lead.smCode} in ${teamSmIds('tl_id', viewer.tlCode)}`,
      eq(lead.isUnassigned, false),
    );
  }

  if (viewer.role === 'acm') {
    if (!viewer.acmCode) throw new AuthzError('FORBIDDEN', 'ACM user has no ACM code');
    return and(
      sql`${lead.smCode} in ${teamSmIds('ccm_id', viewer.acmCode)}`,
      eq(lead.isUnassigned, false),
    );
  }

  if (!viewer.smId) throw new AuthzError('FORBIDDEN', 'Sales user has no SM_ID');
  return and(eq(lead.smCode, viewer.smId), eq(lead.isUnassigned, false));
}

/**
 * Free-text search over the columns a person actually knows a lead by.
 *
 * `location_alt` is in the list because the sheet carries `Location` twice and
 * the two are not always equal (see the schema note): searching only the first
 * would silently drop leads whose town was recorded in the second, which reads
 * as "that lead is not mine" rather than as "that column is duplicated".
 *
 * `likePattern` is imported rather than reimplemented. A second copy of that
 * escaping rule is a second place for a bare `%` to survive into the pattern and
 * turn the search box into a full-table scan on demand.
 */
function searchCondition(term: string): SQL {
  const pattern = likePattern(term);
  return sql`(
    ${lead.leadNo} ilike ${pattern}
    or ${lead.smName} ilike ${pattern}
    or ${lead.location} ilike ${pattern}
    or ${lead.locationAlt} ilike ${pattern}
  )`;
}

/**
 * An `sm_code` owning leads that the `Manpower` roster has never heard of.
 *
 * Flagged, never dropped (spec 6.4). The roster sheet goes stale between
 * uploads while the lead remains a real lead belonging to a real person, so
 * hiding the row would lose somebody's work to fix a spreadsheet.
 *
 * The unassigned sentinel is excluded: `111222-UN` is not a rep missing from the
 * roster, and counting it as one would pin a permanent entry to the admin's
 * reconcile list that no roster edit could ever clear.
 */
function orphanCodeCondition(): SQL {
  return sql`(
    ${lead.smCode} is not null
    and not ${lead.isUnassigned}
    and not exists (
      select 1 from ${manpower} where ${manpower.smId} = ${lead.smCode}
    )
  )`;
}

/**
 * THE where-clause builder. Scoping is element zero, unconditionally.
 *
 * `and()` drops undefined entries, so a global reader — for whom
 * `scopedLeadCondition` returns undefined — simply gets the filters.
 */
function leadWhere(viewer: SessionUser, filters: LeadFilters): SQL | undefined {
  const conditions: Array<SQL | undefined> = [scopedLeadCondition(viewer)];

  if (filters.q) conditions.push(searchCondition(filters.q));
  if (filters.smCode) conditions.push(eq(lead.smCode, filters.smCode));
  if (filters.ownership === 'UNASSIGNED') conditions.push(eq(lead.isUnassigned, true));
  if (filters.ownership === 'ASSIGNED') conditions.push(eq(lead.isUnassigned, false));
  if (filters.registerFrom) conditions.push(gte(lead.registerDate, filters.registerFrom));
  if (filters.registerTo) conditions.push(lte(lead.registerDate, filters.registerTo));

  return and(...conditions);
}

/* ------------------------------------------------------------------ ordering */

/**
 * Newest registration first, `lead_no` as the tiebreaker — always.
 *
 * The tiebreaker is not tidiness. `register_date` holds one value per day across
 * tens of thousands of rows, and offset pagination over a non-total order lets
 * Postgres return ties differently per query: one lead appears on page 2 and
 * again on page 3 while another is never shown at all. `lead_no` is unique, so
 * appending it makes the order total.
 *
 * NULLS LAST because a lead with no register date is one the sheet failed to
 * date, not the newest lead in the book.
 */
const ORDER_BY = [sql`${lead.registerDate} desc nulls last`, asc(lead.leadNo)];

/* ------------------------------------------------------------------ queries */

const LIST_COLUMNS = {
  id: lead.id,
  leadNo: lead.leadNo,
  smCode: lead.smCode,
  smName: lead.smName,
  tlName: lead.tlName,
  ccmName: lead.ccmName,
  location: lead.location,
  locationAlt: lead.locationAlt,
  registerDate: lead.registerDate,
  source: lead.source,
  productType: lead.productType,
  productMix: lead.productMix,
  isUnassigned: lead.isUnassigned,
};

export type LeadRow = typeof lead.$inferSelect;
export type LeadListRow = Pick<LeadRow, keyof typeof LIST_COLUMNS>;

export type Page<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function countLeads(viewer: SessionUser, filters: LeadFilters): Promise<number> {
  const [row] = await db.select({ value: count() }).from(lead).where(leadWhere(viewer, filters));
  return row?.value ?? 0;
}

export async function listLeads(
  viewer: SessionUser,
  filters: LeadFilters,
  page: PageParams,
): Promise<Page<LeadListRow>> {
  const where = leadWhere(viewer, filters);

  // The count runs against the identical predicate, so the "N leads" label and
  // the rows beneath it can never describe different populations.
  const [rows, total] = await Promise.all([
    db
      .select(LIST_COLUMNS)
      .from(lead)
      .where(where)
      .orderBy(...ORDER_BY)
      .limit(page.pageSize)
      .offset(page.offset),
    countLeads(viewer, filters),
  ]);

  return {
    rows,
    total,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: pageCount(total, page.pageSize),
  };
}

/* ------------------------------------------------------------------ summary */

export type LeadSummary = {
  /** Leads the viewer may see at all. For a rep this equals `mine` by construction. */
  total: number;
  mine: number;
  unassigned: number;
  /** Distinct owning `sm_code`s, sentinel excluded — how many reps have leads. */
  reps: number;
  orphanCodes: number;
};

/**
 * Dashboard counters, every one of them computed inside the viewer's scope.
 *
 * The first four are conditional aggregates over a single scan of the same
 * scoped predicate the list uses. Issuing one query per counter would let the
 * headline numbers describe a different population than the rows below them the
 * moment an ingestion run lands between the two — and an ingestion run landing
 * mid-page-load is the normal case here, not the exotic one.
 *
 * A sales user therefore sees `unassigned = 0` and `reps = 1`, which is correct
 * rather than unhelpful: the pool is not theirs to see and the only rep in their
 * scope is themselves.
 */
export async function leadSummary(viewer: SessionUser): Promise<LeadSummary> {
  const where = leadWhere(viewer, EMPTY_LEAD_FILTERS);

  // A global reader has no SM_ID of their own, so "mine" is not a question they
  // can ask; answering 0 beats emitting `sm_code = NULL`, which is never true
  // but reads as though it might be.
  const mine = viewer.smId
    ? sql<number>`(count(*) filter (where ${lead.smCode} = ${viewer.smId}))::int`
    : sql<number>`0::int`;

  const [totals, orphans] = await Promise.all([
    db
      .select({
        total: sql<number>`count(*)::int`,
        mine,
        unassigned: sql<number>`(count(*) filter (where ${lead.isUnassigned}))::int`,
        reps: sql<number>`(count(distinct ${lead.smCode}) filter (where not ${lead.isUnassigned}))::int`,
      })
      .from(lead)
      .where(where),
    db
      .select({ value: sql<number>`count(distinct ${lead.smCode})::int` })
      .from(lead)
      .where(and(where, orphanCodeCondition())),
  ]);

  return {
    total: totals[0]?.total ?? 0,
    mine: totals[0]?.mine ?? 0,
    unassigned: totals[0]?.unassigned ?? 0,
    reps: totals[0]?.reps ?? 0,
    orphanCodes: orphans[0]?.value ?? 0,
  };
}

/* ------------------------------------------------------------- orphan codes */

export type OrphanCodeRow = {
  smCode: string;
  smName: string | null;
  leads: number;
  latestRegisterDate: string | null;
};

/**
 * The admin's reconcile list: codes that own leads but are absent from the roster.
 *
 * Admin-only, and empty for everyone else, on the same reasoning as
 * `listSmIdOptions`: the count in the summary is harmless, but the list of other
 * reps' codes is information a rep has no reason to hold.
 *
 * `register_date` is rendered by `to_char` rather than returned as a bare
 * `max()`. The aggregate bypasses Drizzle's column mapping, so the driver would
 * hand back whatever it decides a `date` is; formatting it in SQL makes the
 * shape the type claims.
 */
export async function listOrphanCodes(
  viewer: SessionUser,
  limit = 50,
): Promise<OrphanCodeRow[]> {
  if (viewer.role !== 'admin') return [];

  return db
    .select({
      // Narrowed here rather than re-checked at every call site: the predicate
      // below already excludes NULL codes.
      smCode: sql<string>`${lead.smCode}`,
      smName: sql<string | null>`min(${lead.smName})`,
      leads: sql<number>`count(*)::int`,
      latestRegisterDate: sql<string | null>`to_char(max(${lead.registerDate}), 'YYYY-MM-DD')`,
    })
    .from(lead)
    .where(and(scopedLeadCondition(viewer), orphanCodeCondition()))
    .groupBy(lead.smCode)
    // Loudest first: the code with two thousand leads behind it is the roster
    // gap worth chasing, not the one with a single stray row.
    .orderBy(sql`count(*) desc`, asc(lead.smCode))
    .limit(limit);
}
