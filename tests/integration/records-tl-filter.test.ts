/**
 * The team-leader drill-down — `?tlId=` on the record grid.
 *
 * An area manager could always see that Naresh Samal's team logged 93 policies
 * and had no way to look at the 93. This filter is that link, and it is the kind
 * of filter that has to be proved rather than eyeballed: it names a scope in the
 * URL, so the question is not "does it narrow" but "can it ever widen".
 *
 * The answer has to come from `recordWhere`, not from the parser. Dropping the
 * parameter for the wrong role is the readable defence; the load-bearing one is
 * that the predicate is ANDed onto `scopedRecordCondition` rather than replacing
 * it, which is asserted here by forcing a filter past the parser entirely.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, manpowerOverride, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { DEFAULT_PAGE_SIZE, type PageParams } from '@/lib/pagination';
import {
  EMPTY_FILTERS,
  FILTER_KEYS,
  filterFormValues,
  hasActiveFilters,
  parseRecordFilters,
  type RecordFilters,
} from '@/lib/records/filters';
import { countRecords, listRecords, listTlOptions } from '@/lib/records/query';
import { makeUser, truncateAll } from '../helpers/db';

const PAGE: PageParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 };

/** Cluster CCM01 holds two teams; CCM02 holds a third nobody here may reach. */
const LEAD_1 = 'TL001'; // a WORKING team leader — books policies of their own
const LEAD_2 = 'TL002'; // leads a team, has no roster row of their own
const LEAD_OUT = 'TL009'; // another cluster entirely

const REP_A1 = 'C2CM10001'; // TL001
const REP_A2 = 'C2CM10002'; // TL001
const REP_B1 = 'C2CM20001'; // TL002
const REP_OUT = 'C2CM90001'; // TL009, CCM02

const APPS_A1 = '5920000001';
const APPS_A2 = '5920000002';
const APPS_B1 = '5920000003';
const APPS_OUT = '5920000004';
const APPS_LEAD = '5920000005'; // the team leader's own book

function filters(over: Partial<RecordFilters> = {}): RecordFilters {
  return { ...EMPTY_FILTERS, ...over };
}

let tl: SessionUser;
let acm: SessionUser;
let admin: SessionUser;
let outsider: SessionUser;
let adminId: string;

async function session(overrides: Parameters<typeof makeUser>[0]): Promise<SessionUser> {
  const row = await makeUser(overrides);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    smId: row.smId,
    tlCode: row.tlCode,
    acmCode: row.acmCode,
    isActive: true,
  };
}

async function appsNosFor(viewer: SessionUser, f: RecordFilters) {
  const { rows } = await listRecords(viewer, f, PAGE);
  return rows.map((r) => r.appsNo).sort();
}

beforeEach(async () => {
  await truncateAll();

  await db.insert(manpower).values([
    { smId: REP_A1, smName: 'Rep A One', tlId: LEAD_1, ccmId: 'CCM01' },
    { smId: REP_A2, smName: 'Rep A Two', tlId: LEAD_1, ccmId: 'CCM01' },
    { smId: REP_B1, smName: 'Rep B One', tlId: LEAD_2, ccmId: 'CCM01' },
    // The leader's own self-row, the shape the Manpower sheet usually writes.
    { smId: LEAD_1, smName: 'Tina Lead', tlId: LEAD_1, ccmId: 'CCM01' },
    { smId: REP_OUT, smName: 'Outsider', tlId: LEAD_OUT, ccmId: 'CCM02' },
    // Not a person. It names ITSELF as its own team leader, which is exactly how
    // a bucket ends up offered in a picker of people.
    { smId: 'DIY', smName: 'Digital', tlId: 'DIY', ccmId: 'CCM01' },
  ]);

  await db.insert(salesRecord).values([
    { appsNo: APPS_A1, smId: REP_A1, smName: 'Rep A One', status: 'ISSUED', extra: {} },
    { appsNo: APPS_A2, smId: REP_A2, smName: 'Rep A Two', status: 'ISSUED', extra: {} },
    { appsNo: APPS_B1, smId: REP_B1, smName: 'Rep B One', status: 'ISSUED', extra: {} },
    { appsNo: APPS_OUT, smId: REP_OUT, smName: 'Outsider', status: 'ISSUED', extra: {} },
    { appsNo: APPS_LEAD, smId: LEAD_1, smName: 'Tina Lead', status: 'ISSUED', extra: {} },
  ]);

  admin = await session({ role: 'admin', smId: null, email: 'admin@example.test' });
  adminId = admin.id;
  tl = await session({ role: 'tl', smId: null, tlCode: LEAD_1, email: 'tl001@example.test' });
  acm = await session({ role: 'acm', smId: null, acmCode: 'CCM01', email: 'ccm01@example.test' });
  outsider = await session({ role: 'sales', smId: REP_OUT, email: 'out@example.test' });
});

describe('who may ask for a team at all', () => {
  it('is parsed for an admin and an area manager', () => {
    expect(parseRecordFilters({ tlId: LEAD_1 }, admin).tlId).toBe(LEAD_1);
    expect(parseRecordFilters({ tlId: LEAD_1 }, acm).tlId).toBe(LEAD_1);
  });

  it('is dropped for a team leader, for whom it is meaningless', () => {
    // A TL leads exactly one team. The filter could only ever be a no-op or an
    // empty grid, and offering it would suggest they can reach another team.
    expect(parseRecordFilters({ tlId: LEAD_1 }, tl).tlId).toBeNull();
    expect(parseRecordFilters({ tlId: LEAD_2 }, tl).tlId).toBeNull();
  });

  it('is dropped for a sales user and an approver', () => {
    expect(parseRecordFilters({ tlId: LEAD_1 }, { role: 'sales' }).tlId).toBeNull();
    expect(parseRecordFilters({ tlId: LEAD_1 }, { role: 'approver' }).tlId).toBeNull();
  });

  it('uppercases the code, because the roster stores it uppercase', () => {
    // `teamSmIds` compares `tl_id` verbatim; a lowercase code would resolve to an
    // empty team and read on screen as "this team leader has no policies".
    expect(parseRecordFilters({ tlId: LEAD_1.toLowerCase() }, acm).tlId).toBe(LEAD_1);
  });

  it('degrades rather than rejecting a hand-edited value', () => {
    expect(parseRecordFilters({ tlId: '' }, acm).tlId).toBeNull();
    expect(parseRecordFilters({ tlId: '   ' }, acm).tlId).toBeNull();
    expect(parseRecordFilters({ tlId: 'x'.repeat(500) }, acm).tlId).toBeNull();
    expect(parseRecordFilters({ tlId: [LEAD_1, LEAD_2] }, acm).tlId).toBe(LEAD_1);
  });

  it('is carried through the rest of the filter plumbing', () => {
    expect(EMPTY_FILTERS.tlId).toBeNull();
    expect(FILTER_KEYS).toContain('tlId');
    expect(hasActiveFilters(filters({ tlId: LEAD_1 }))).toBe(true);
    expect(filterFormValues(EMPTY_FILTERS).tlId).toBe('');
    expect(filterFormValues(filters({ tlId: LEAD_1 })).tlId).toBe(LEAD_1);
  });
});

describe('an area manager drilling into one of their own teams', () => {
  it('returns that team and nobody else', async () => {
    expect(await appsNosFor(acm, filters({ tlId: LEAD_1 }))).toEqual([
      APPS_A1,
      APPS_A2,
      APPS_LEAD,
    ]);
    expect(await countRecords(acm, filters({ tlId: LEAD_1 }))).toBe(3);
  });

  it("includes the team leader's own book", async () => {
    // `teamSmIds('tl_id', …)` unions the code itself, so a working TL's own
    // policies count towards their team — otherwise the drill-down would show
    // fewer rows than the performance row it was clicked from.
    expect(await appsNosFor(acm, filters({ tlId: LEAD_1 }))).toContain(APPS_LEAD);
  });

  it('switches cleanly to the other team', async () => {
    expect(await appsNosFor(acm, filters({ tlId: LEAD_2 }))).toEqual([APPS_B1]);
  });

  it('sees the whole cluster again with no filter', async () => {
    expect(await countRecords(acm, filters())).toBe(4);
  });

  it('combines with the rep filter rather than overriding it', async () => {
    expect(await appsNosFor(acm, filters({ tlId: LEAD_1, smId: REP_A2 }))).toEqual([APPS_A2]);
    // A rep who is not on the named team is the intersection of two disjoint
    // sets — empty, never one of the two.
    expect(await appsNosFor(acm, filters({ tlId: LEAD_2, smId: REP_A2 }))).toEqual([]);
  });

  it('follows an admin reassignment, not the raw sheet', async () => {
    await db.insert(manpowerOverride).values([
      { smId: REP_B1, tlId: LEAD_1, overriddenBy: adminId },
    ]);

    expect(await appsNosFor(acm, filters({ tlId: LEAD_1 }))).toEqual([
      APPS_A1,
      APPS_A2,
      APPS_B1,
      APPS_LEAD,
    ]);
    expect(await appsNosFor(acm, filters({ tlId: LEAD_2 }))).toEqual([]);
  });
});

describe('the filter narrows a scope and can never widen one', () => {
  it('returns nothing for a team leader in another cluster', async () => {
    // The reason this is safe to hand a manager at all. `recordWhere` ANDs the
    // team predicate onto `scopedRecordCondition`, so a hand-typed code from
    // another cluster intersects to empty — it does not select that cluster.
    expect(await countRecords(acm, filters({ tlId: LEAD_OUT }))).toBe(0);
    expect(await appsNosFor(acm, filters({ tlId: LEAD_OUT }))).toEqual([]);
  });

  it('returns nothing for a code that names no team at all', async () => {
    expect(await countRecords(acm, filters({ tlId: 'NOBODY' }))).toBe(0);
  });

  it('still refuses when the filter is forced past the parser', async () => {
    // Simulates a refactor that stops stripping `tlId` for a sales user. The
    // scoped predicate is element zero of the array and no filter can remove it,
    // so the worst outcome is an empty list — never another team's rows.
    expect(await appsNosFor(outsider, filters())).toEqual([APPS_OUT]);
    expect(await appsNosFor(outsider, filters({ tlId: LEAD_1 }))).toEqual([]);
    expect(await appsNosFor(tl, filters({ tlId: LEAD_2 }))).toEqual([]);
  });

  it('lets an admin, who is unscoped, reach any team', async () => {
    expect(await appsNosFor(admin, filters({ tlId: LEAD_OUT }))).toEqual([APPS_OUT]);
  });
});

describe('the team-leader picker', () => {
  it('offers an area manager the team leaders inside their cluster and no others', async () => {
    expect(await listTlOptions(acm)).toEqual([
      { tlId: LEAD_1, tlName: 'Tina Lead' },
      // No roster row of their own, so there is no name to show — the code
      // stands alone rather than the option being dropped.
      { tlId: LEAD_2, tlName: null },
    ]);
  });

  it('never offers a placeholder bucket as a team leader', async () => {
    const codes = (await listTlOptions(acm)).map((o) => o.tlId);
    expect(codes).not.toContain('DIY');
  });

  it('offers an admin every team leader on the roster', async () => {
    expect((await listTlOptions(admin)).map((o) => o.tlId)).toEqual([LEAD_1, LEAD_2, LEAD_OUT]);
  });

  it('offers nothing to the roles that may not use the filter', async () => {
    // Not a scope leak — the filter could not widen anything — but a control the
    // parser would ignore is a screen lying about what it can do.
    expect(await listTlOptions(tl)).toEqual([]);
    expect(await listTlOptions(outsider)).toEqual([]);
  });

  it('follows an override, and names the leader from their own roster row', async () => {
    await db.insert(manpowerOverride).values([
      { smId: REP_B1, tlId: LEAD_1, overriddenBy: adminId },
    ]);

    // TL002 led exactly one rep and no longer leads anybody, so the picker stops
    // offering a team that would return an empty grid.
    expect(await listTlOptions(acm)).toEqual([{ tlId: LEAD_1, tlName: 'Tina Lead' }]);
  });
});
