/**
 * The unassigned pool, and the routing bug that made it pointless.
 *
 * Two halves, and they are one feature. The pool is where a rep FINDS a policy
 * credited to nobody; `MAPPING_DIY` is the two-rung chain that decides the claim
 * they raise from it. Before the fix asserted below, no claim on a real DIY
 * record ever reached that chain — the Manpower sheet names each bucket at all
 * three rungs (`{sm_id:'DIY', tl_id:'DIY', ccm_id:'DIY'}` in the live roster), so
 * the "nobody on the other side" test read `tl_id = 'DIY'` as a real team, routed
 * the claim through MAPPING_BETWEEN_TEAMS, and its fourth rung then resolved
 * `ACM_OF_SM` for the code `DIY`, found no account, and fell to the
 * administrators. A screen full of Claim buttons that all end up unrouted is
 * worse than no screen, so the two are tested together.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, manpower, period, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { DEFAULT_PAGE_SIZE, type PageParams } from '@/lib/pagination';
import {
  EMPTY_POOL_FILTERS,
  listPool,
  parsePoolFilters,
  poolSummary,
  type PoolFilters,
} from '@/lib/records/pool';
import { chainKeyFor, mappingShapeFor } from '@/lib/workflows';
import { makeUser, sessionFor, truncateAll } from '../helpers/db';

const PAGE: PageParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 };

const REP = 'ICCSP90766';
const OTHER_REP = 'C2CM21350';

function filters(over: Partial<PoolFilters> = {}): PoolFilters {
  return { ...EMPTY_POOL_FILTERS, ...over };
}

/**
 * The roster as the live workbook actually writes it.
 *
 * The two bucket rows naming THEMSELVES at all three rungs is not artistic
 * licence — it is the exact shape confirmed in the production database, and it
 * is the whole reason the old classification was wrong. A fixture that left
 * `tl_id` null on the bucket rows would have passed against the broken code.
 */
async function roster() {
  await db.insert(manpower).values([
    { smId: REP, smName: 'Rep One', tlId: 'TL001', ccmId: 'CCM001', isOrphan: false },
    { smId: OTHER_REP, smName: 'Rep Two', tlId: 'TL002', ccmId: 'CCM002', isOrphan: false },
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY', isOrphan: false },
    { smId: '111222-UN', smName: 'DIY', tlId: '111222-UN', ccmId: '111222-UN', isOrphan: false },
  ]);
}

async function makeRecord(values: Partial<typeof salesRecord.$inferInsert> & { appsNo: string }) {
  const [row] = await db
    .insert(salesRecord)
    .values({ smId: 'DIY', ...values })
    .returning();
  return row;
}

/* ------------------------------------------------------------- the routing */

describe('mapping classification for a placeholder counterparty', () => {
  beforeEach(async () => {
    await truncateAll();
    await roster();
  });

  it.each(['DIY', '111222-UN'])(
    'routes a claim against %s to MAPPING_DIY, not between teams',
    async (bucket) => {
      const [shape, chainKey] = await db.transaction(async (tx) => [
        await mappingShapeFor(tx, REP, bucket),
        await chainKeyFor(tx, {
          category: 'MAPPING',
          direction: 'CLAIM_IN',
          submitterSmId: REP,
          counterpartySmId: bucket,
        }),
      ]);

      expect(shape).toBe('DIY');
      expect(chainKey).toBe('MAPPING_DIY');
    },
  );

  it('matches a bucket code however the source cased or padded it', async () => {
    const shape = await db.transaction((tx) => mappingShapeFor(tx, REP, ' diy '));
    expect(shape).toBe('DIY');
  });

  /**
   * The guard against over-correcting. The fix must catch the buckets and
   * nothing else — a claim against a real rep in another team is still a
   * between-teams request, and demoting it to the two-rung DIY chain would skip
   * both ACMs on a sale genuinely moving between books.
   */
  it('still routes a claim against a real rep in another team through both teams', async () => {
    const chainKey = await db.transaction((tx) =>
      chainKeyFor(tx, {
        category: 'MAPPING',
        direction: 'CLAIM_IN',
        submitterSmId: REP,
        counterpartySmId: OTHER_REP,
      }),
    );
    expect(chainKey).toBe('MAPPING_BETWEEN_TEAMS');
  });
});

/* ---------------------------------------------------------------- the pool */

describe('the unassigned pool query', () => {
  let rep: SessionUser;
  let stranger: SessionUser;
  let tl: SessionUser;
  let acm: SessionUser;
  let approver: SessionUser;
  let openPeriodId: string;
  let closedPeriodId: string;

  beforeEach(async () => {
    await truncateAll();
    await roster();

    rep = sessionFor(await makeUser({ role: 'sales', smId: REP }));
    stranger = sessionFor(await makeUser({ role: 'sales', smId: OTHER_REP }));
    tl = sessionFor(await makeUser({ role: 'tl', tlCode: 'TL001' }));
    acm = sessionFor(await makeUser({ role: 'acm', acmCode: 'CCM001' }));
    approver = sessionFor(await makeUser({ role: 'approver', smId: null }));

    // Only one period may be OPEN at a time — `period_one_open` enforces it.
    const periods = await db
      .insert(period)
      .values([
        {
          code: '2026-08',
          label: 'Aug 2026',
          startsOn: '2026-08-01',
          endsOn: '2026-08-31',
          status: 'OPEN',
        },
        {
          code: '2026-07',
          label: 'Jul 2026',
          startsOn: '2026-07-01',
          endsOn: '2026-07-31',
          status: 'CLOSED',
        },
      ])
      .returning();
    openPeriodId = periods.find((p) => p.code === '2026-08')!.id;
    closedPeriodId = periods.find((p) => p.code === '2026-07')!.id;

    await makeRecord({
      appsNo: 'POOL-DIY-1',
      smId: 'DIY',
      clientName: 'Kotturu Srivenu',
      location: 'Pune',
      issuedDate: '2026-08-10',
      status: 'ISSUED',
      productName: 'E-TOUCH NEW',
      policyNo: 'P-SECRET-1',
      fp: '12345.00',
      anp: '9999.00',
      leadId: 'L-1',
      periodId: openPeriodId,
    });
    await makeRecord({
      appsNo: 'POOL-UN-1',
      smId: '111222-UN',
      clientName: 'Nobody Yet',
      issuedDate: '2026-08-02',
      periodId: openPeriodId,
    });
    // Same pool, a cycle that is closed: visible, but not claimable.
    await makeRecord({
      appsNo: 'POOL-DIY-CLOSED',
      smId: 'DIY',
      issuedDate: '2026-07-15',
      periodId: closedPeriodId,
    });
    // Owned by real people — these must never appear in the pool.
    await makeRecord({ appsNo: 'MINE-1', smId: REP, periodId: openPeriodId });
    await makeRecord({ appsNo: 'THEIRS-1', smId: OTHER_REP, periodId: openPeriodId });
  });

  /** An open ownership claim on one pool record, raised by `by` for `forSmId`. */
  async function openClaim(
    appsNo: string,
    by: SessionUser,
    forSmId: string,
    fieldName = 'smId',
  ) {
    const [record] = await db
      .select()
      .from(salesRecord)
      .where(eq(salesRecord.appsNo, appsNo))
      .limit(1);

    await db.insert(correctionRequest).values({
      recordId: record.id,
      appsNo,
      category: fieldName === 'smId' ? 'MAPPING' : 'AUTOPAY',
      direction: fieldName === 'smId' ? 'CLAIM_IN' : null,
      fieldName,
      fieldLabel: fieldName,
      originalValue: record.smId,
      proposedValue: forSmId,
      submittedBy: by.id,
      smId: forSmId,
      counterpartySmId: record.smId,
      status: 'PENDING',
      periodId: record.periodId,
    });
  }

  it('lists exactly the bucket records, and nobody real', async () => {
    const pool = await listPool(rep, filters(), PAGE);

    expect(pool.total).toBe(3);
    expect(pool.rows.map((r) => r.appsNo).sort()).toEqual([
      'POOL-DIY-1',
      'POOL-DIY-CLOSED',
      'POOL-UN-1',
    ]);
    expect(pool.rows.map((r) => r.bucket).sort()).toEqual(['111222-UN', 'DIY', 'DIY']);
  });

  /**
   * The exception itself, stated as a test.
   *
   * `stranger` is in a different team under a different ACM, and
   * `scopedRecordCondition` would show them none of these rows. The pool is
   * deliberately the same list for everybody — a claim nobody can see is a claim
   * nobody can raise.
   */
  it('shows the same pool to a rep, a team leader and an area manager', async () => {
    for (const viewer of [rep, stranger, tl, acm]) {
      const pool = await listPool(viewer, filters(), PAGE);
      expect(pool.total, `${viewer.role} ${viewer.smId ?? ''}`).toBe(3);
    }
  });

  it('refuses a role that cannot raise a claim', async () => {
    await expect(listPool(approver, filters(), PAGE)).rejects.toBeInstanceOf(AuthzError);
    await expect(poolSummary(approver)).rejects.toThrow(/unassigned pool/i);
  });

  /**
   * The projection is the second half of what makes the exception safe.
   *
   * Every rep in the company reads every row of this list, so a column added
   * here is a column published company-wide. `policyNo` is a second identifier
   * into systems this portal does not own; `fp` and `anp` are premium figures.
   * Neither helps somebody recognise a sale as theirs.
   */
  it('publishes nothing beyond what identifies the sale', async () => {
    const [row] = (await listPool(rep, filters({ q: 'POOL-DIY-1' }), PAGE)).rows;

    expect(Object.keys(row).sort()).toEqual([
      'appsNo',
      'bucket',
      'clientName',
      'issuedDate',
      'location',
      'pendingClaim',
      'periodOpen',
      'productName',
      'status',
    ]);
  });

  it('marks a record in a closed cycle as unclaimable', async () => {
    const pool = await listPool(rep, filters(), PAGE);
    const byApps = Object.fromEntries(pool.rows.map((r) => [r.appsNo, r]));

    expect(byApps['POOL-DIY-1'].periodOpen).toBe(true);
    expect(byApps['POOL-DIY-CLOSED'].periodOpen).toBe(false);
  });

  it('orders by issuance date, newest first, with a total tiebreak', async () => {
    const pool = await listPool(rep, filters(), PAGE);
    expect(pool.rows.map((r) => r.appsNo)).toEqual([
      'POOL-DIY-1',
      'POOL-UN-1',
      'POOL-DIY-CLOSED',
    ]);
  });

  it('searches application, client and location, and escapes the pattern', async () => {
    expect((await listPool(rep, filters({ q: 'Srivenu' }), PAGE)).total).toBe(1);
    expect((await listPool(rep, filters({ q: 'Pune' }), PAGE)).total).toBe(1);
    expect((await listPool(rep, filters({ q: 'POOL-UN' }), PAGE)).total).toBe(1);
    // A bare wildcard is a term, not a pattern — otherwise the search box is a
    // way to force a full scan on demand.
    expect((await listPool(rep, filters({ q: '%' }), PAGE)).total).toBe(0);
  });

  it('narrows by issuance date and by cycle', async () => {
    expect((await listPool(rep, filters({ issuedFrom: '2026-08-05' }), PAGE)).total).toBe(1);
    expect((await listPool(rep, filters({ issuedTo: '2026-08-05' }), PAGE)).total).toBe(2);
    expect((await listPool(rep, filters({ periodId: closedPeriodId }), PAGE)).total).toBe(1);
  });

  it('defaults the cycle filter to the open period', async () => {
    const { filters: parsed, period: resolved } = await parsePoolFilters({});
    expect(resolved.code).toBe('2026-08');
    expect(parsed.periodId).toBe(openPeriodId);

    // And nothing here rejects: an unreadable date degrades to no filter.
    const junk = await parsePoolFilters({ issuedFrom: 'yesterday', period: 'all' });
    expect(junk.filters.issuedFrom).toBeNull();
    expect(junk.filters.periodId).toBeNull();
  });

  /* ------------------------------------------------------- pending claims */

  it('badges a record whose ownership is already claimed, and says whose', async () => {
    await openClaim('POOL-DIY-1', rep, REP);

    const mine = (await listPool(rep, filters({ q: 'POOL-DIY-1' }), PAGE)).rows[0];
    expect(mine.pendingClaim).toEqual({ mine: true, requestId: expect.any(String) });

    // Somebody else's claim exists, and names nobody: no claimant, no request id
    // to follow, nothing that says who is competing for the sale.
    const theirs = (await listPool(stranger, filters({ q: 'POOL-DIY-1' }), PAGE)).rows[0];
    expect(theirs.pendingClaim).toEqual({ mine: false, requestId: null });
  });

  /**
   * A manager's books, not just their own submissions.
   *
   * The claim below was raised BY the rep, so `submitted_by` does not name the
   * TL — but it lands in the TL's team and is the claim that decides whether
   * anyone else on that team may raise another, so it is theirs to see.
   */
  it('counts a claim landing in a manager team as the manager own', async () => {
    await openClaim('POOL-DIY-1', rep, REP);

    const forTl = (await listPool(tl, filters({ q: 'POOL-DIY-1' }), PAGE)).rows[0];
    expect(forTl.pendingClaim?.mine).toBe(true);

    const forAcm = (await listPool(acm, filters({ q: 'POOL-DIY-1' }), PAGE)).rows[0];
    expect(forAcm.pendingClaim?.mine).toBe(true);
  });

  it('ignores an open correction on any other field', async () => {
    await openClaim('POOL-DIY-1', rep, REP, 'autopay');

    const row = (await listPool(rep, filters({ q: 'POOL-DIY-1' }), PAGE)).rows[0];
    expect(row.pendingClaim).toBeNull();
  });

  it('leaves a record with no open claim unbadged, and does not duplicate rows', async () => {
    await openClaim('POOL-DIY-1', rep, REP);
    await openClaim('POOL-DIY-1', rep, REP, 'autopay');

    const pool = await listPool(rep, filters(), PAGE);
    // Two open corrections on one record is still one row — the join must not
    // multiply it, which the partial unique index is what guarantees.
    expect(pool.rows.filter((r) => r.appsNo === 'POOL-DIY-1')).toHaveLength(1);
    expect(pool.total).toBe(3);
    expect(pool.rows.find((r) => r.appsNo === 'POOL-UN-1')?.pendingClaim).toBeNull();
  });

  /* -------------------------------------------------------------- summary */

  it('counts the pool the same way the rows describe it', async () => {
    const before = await poolSummary(rep);
    expect(before).toEqual({ total: 3, claimable: 2, claimed: 0, mine: 0 });

    await openClaim('POOL-DIY-1', rep, REP);

    expect(await poolSummary(rep)).toEqual({ total: 3, claimable: 1, claimed: 1, mine: 1 });
    // The same claim, seen by a rep it has nothing to do with.
    expect(await poolSummary(stranger)).toEqual({ total: 3, claimable: 1, claimed: 1, mine: 0 });
  });
});
