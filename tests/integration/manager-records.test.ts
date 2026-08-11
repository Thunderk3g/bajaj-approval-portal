/**
 * `/tl/records` and `/acm/records` — what a manager may read, and what they may not.
 *
 * The pages are thin: they call `listRecords`, `countRecords` and `getRecord`
 * with the session, exactly as the rep's own screens do, and the scope comes
 * from `scopedRecordCondition`. So the tests that matter are asked of those
 * functions with a TL and an ACM session rather than through the components —
 * a component test would assert React renders an array, which is not the claim
 * anyone cares about.
 *
 * The security-critical assertion is the detail lookup: a manager typing another
 * team's Apps_No into the URL must get a 404, not the record. That is the same
 * boundary `records-scope.test.ts` holds for a sales user, restated here because
 * the manager scope is a subquery over the roster rather than one equality and
 * can therefore fail in ways the rep's cannot — an override, a missing roster
 * row, a bucket code.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, manpowerOverride, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { DEFAULT_PAGE_SIZE, type PageParams } from '@/lib/pagination';
import { EMPTY_FILTERS, parseRecordFilters, type RecordFilters } from '@/lib/records/filters';
import { countRecords, getRecord, listRecords } from '@/lib/records/query';
import { makeUser, truncateAll } from '../helpers/db';

const PAGE: PageParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 };

/** Cluster CCM01: two teams. Cluster CCM02: one, and nobody here may see it. */
const REP_A1 = 'C2CM10001'; // TL001, CCM01
const REP_A2 = 'C2CM10002'; // TL001, CCM01
const REP_B1 = 'C2CM20001'; // TL002, CCM01
const REP_OUT = 'C2CM90001'; // TL009, CCM02

const APPS_A1 = '5920000001';
const APPS_A2 = '5920000002';
const APPS_B1 = '5920000003';
const APPS_OUT = '5920000004';

function filters(over: Partial<RecordFilters> = {}): RecordFilters {
  return { ...EMPTY_FILTERS, ...over };
}

let tl: SessionUser;
let acm: SessionUser;
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

beforeEach(async () => {
  await truncateAll();

  await db.insert(manpower).values([
    { smId: REP_A1, smName: 'Rep A One', tlId: 'TL001', ccmId: 'CCM01' },
    { smId: REP_A2, smName: 'Rep A Two', tlId: 'TL001', ccmId: 'CCM01' },
    { smId: REP_B1, smName: 'Rep B One', tlId: 'TL002', ccmId: 'CCM01' },
    { smId: REP_OUT, smName: 'Outsider', tlId: 'TL009', ccmId: 'CCM02' },
  ]);

  await db.insert(salesRecord).values([
    { appsNo: APPS_A1, smId: REP_A1, smName: 'Rep A One', status: 'ISSUED', extra: {} },
    { appsNo: APPS_A2, smId: REP_A2, smName: 'Rep A Two', status: 'ISSUED', extra: {} },
    { appsNo: APPS_B1, smId: REP_B1, smName: 'Rep B One', status: 'ISSUED', extra: {} },
    { appsNo: APPS_OUT, smId: REP_OUT, smName: 'Outsider', status: 'ISSUED', extra: {} },
  ]);

  adminId = (await makeUser({ role: 'admin', email: 'admin@example.test' })).id;
  tl = await session({ role: 'tl', smId: null, tlCode: 'TL001', email: 'tl001@example.test' });
  acm = await session({ role: 'acm', smId: null, acmCode: 'CCM01', email: 'ccm01@example.test' });
});

describe('a team leader sees their team and only their team', () => {
  it('lists every rep beneath them and nobody else', async () => {
    const { rows, total } = await listRecords(tl, filters(), PAGE);

    expect(rows.map((r) => r.appsNo).sort()).toEqual([APPS_A1, APPS_A2]);
    expect(total).toBe(2);
    expect(await countRecords(tl, filters())).toBe(2);
  });

  it('cannot reach another team by Apps_No — the detail lookup is a 404, not a 403', async () => {
    // The whole point of /tl/records/[appsNo]: the page renders notFound() on a
    // null, so a manager guessing at application numbers cannot tell "belongs to
    // another team" apart from "does not exist". A thrown FORBIDDEN would be the
    // leak, because it would confirm the application is real.
    expect(await getRecord(tl, APPS_B1)).toBeNull();
    expect(await getRecord(tl, APPS_OUT)).toBeNull();
    expect(await getRecord(tl, '0000000000')).toBeNull();

    // And the one that IS theirs still resolves, so the assertion above is about
    // scope rather than about the lookup being broken.
    expect((await getRecord(tl, APPS_A1))?.appsNo).toBe(APPS_A1);
  });

  it('follows an admin reassignment rather than the raw sheet', async () => {
    // The screen must show the reps this manager is ANSWERABLE for. An override
    // that moves a rep moves their records with them, in both directions.
    await db.insert(manpowerOverride).values([
      { smId: REP_B1, tlId: 'TL001', overriddenBy: adminId },
      { smId: REP_A2, tlId: 'TL002', overriddenBy: adminId },
    ]);

    const { rows } = await listRecords(tl, filters(), PAGE);
    expect(rows.map((r) => r.appsNo).sort()).toEqual([APPS_A1, APPS_B1]);
    expect(await getRecord(tl, APPS_A2)).toBeNull();
  });

  it('fails closed when the account carries no TL code', async () => {
    const codeless: SessionUser = { ...tl, tlCode: null };
    await expect(listRecords(codeless, filters(), PAGE)).rejects.toBeInstanceOf(AuthzError);
    await expect(getRecord(codeless, APPS_A1)).rejects.toBeInstanceOf(AuthzError);
  });
});

describe('an area manager sees every rep under the cluster, across teams', () => {
  it('spans both team leaders', async () => {
    const { rows, total } = await listRecords(acm, filters(), PAGE);

    expect(rows.map((r) => r.appsNo).sort()).toEqual([APPS_A1, APPS_A2, APPS_B1]);
    expect(total).toBe(3);
  });

  it('stops at the cluster boundary', async () => {
    expect(await getRecord(acm, APPS_OUT)).toBeNull();
  });

  it('fails closed when the account carries no ACM code', async () => {
    const codeless: SessionUser = { ...acm, acmCode: null };
    await expect(countRecords(codeless, filters())).rejects.toBeInstanceOf(AuthzError);
  });
});

describe('the rep filter narrows a manager scope and can never widen it', () => {
  it('is parsed for a manager, unlike for a rep', () => {
    // A rep has one book, so the control is meaningless for them; a manager has
    // many, so it is the first thing they reach for.
    expect(parseRecordFilters({ smId: REP_A2 }, tl).smId).toBe(REP_A2);
    expect(parseRecordFilters({ smId: REP_A2 }, acm).smId).toBe(REP_A2);
    expect(parseRecordFilters({ smId: REP_A2 }, { role: 'sales' }).smId).toBeNull();

    // Uppercased, because sales_record.sm_id carries an uppercase CHECK and a
    // lowercase filter would silently match nothing.
    expect(parseRecordFilters({ smId: REP_A2.toLowerCase() }, tl).smId).toBe(REP_A2);
  });

  it('returns one rep book when the rep is theirs', async () => {
    const { rows } = await listRecords(tl, filters({ smId: REP_A2 }), PAGE);
    expect(rows.map((r) => r.appsNo)).toEqual([APPS_A2]);
  });

  it('returns nothing when a hand-typed SM_ID is outside the team', async () => {
    // `recordWhere` ANDs the filter with the scope predicate, so the worst a
    // crafted `?smId=` can do is narrow the manager's own team to empty.
    expect(await countRecords(tl, filters({ smId: REP_OUT }))).toBe(0);
    expect(await countRecords(acm, filters({ smId: REP_OUT }))).toBe(0);
  });
});
