/**
 * The performance report against the real database — mostly a scoping suite.
 *
 * The figures are arithmetic and are unit-tested next door. What can only be
 * checked here is who the numbers are ABOUT, and that is the part where a
 * mistake is silent: a report that quietly widened a team leader's scope would
 * look entirely correct to the team leader reading it, and would be showing
 * them another cluster's book.
 *
 * The three assertions that matter are therefore stated separately and by name:
 * a TL sees exactly their reps, an ACM sees every rep across their teams, and a
 * rep sees nobody but themselves.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, manpowerOverride, period, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { loadPerformance, loadRepStanding } from '@/lib/dashboard/performance';
import { makeUser, truncateAll } from '../helpers/db';

const TL1 = 'TL001';
const TL2 = 'TL002';
const TL3 = 'TL003';
const ACM1 = 'CCM001';
const ACM2 = 'CCM002';

let admin: SessionUser;
let tl: SessionUser;
let acm: SessionUser;
let rep: SessionUser;
let julyId: string;

type RowSpec = {
  issued?: number;
  refused?: number;
  pending?: number;
  /** A status the portal has no name for — the tripwire, not the normal case. */
  stray?: number;
  anp?: string;
  periodId?: string | null;
};

let counter = 0;

/** Policies for one code, split across statuses. Apps_No is unique, so it counts. */
async function policies(smId: string, spec: RowSpec) {
  const rows: Array<Record<string, unknown>> = [];
  const push = (status: string, times: number) => {
    for (let i = 0; i < times; i += 1) {
      counter += 1;
      rows.push({
        appsNo: `APP${String(counter).padStart(6, '0')}`,
        smId,
        status,
        anp: spec.anp ?? '100.00',
        fp: '10.00',
        periodId: spec.periodId ?? null,
        extra: {},
      });
    }
  };

  push('ISSUED', spec.issued ?? 0);
  push('REJECTED', spec.refused ?? 0);
  push('PENDING', spec.pending ?? 0);
  push('C_OFFER', spec.stray ?? 0);

  if (rows.length > 0) await db.insert(salesRecord).values(rows as never);
}

const session = (over: Partial<SessionUser> & { id: string; role: SessionUser['role'] }): SessionUser => ({
  email: `${over.id}@example.test`,
  name: 'Test',
  smId: null,
  tlCode: null,
  acmCode: null,
  isActive: true,
  ...over,
});

beforeEach(async () => {
  await truncateAll();
  counter = 0;

  const adminRow = await makeUser({ role: 'admin', smId: null });
  admin = session({ id: adminRow.id, role: 'admin' });

  await db.insert(manpower).values([
    { smId: 'ICCSP1', smName: 'Rep One', tlId: TL1, tlName: 'Sunil P', ccmId: ACM1, ccmName: 'Amit K' },
    { smId: 'ICCSP2', smName: 'Rep Two', tlId: TL1, tlName: 'Sunil P', ccmId: ACM1, ccmName: 'Amit K' },
    { smId: 'ICCSP3', smName: 'Rep Three', tlId: TL2, tlName: 'Meera R', ccmId: ACM1, ccmName: 'Amit K' },
    { smId: 'ICCSP4', smName: 'Rep Four', tlId: TL3, tlName: 'Ravi N', ccmId: ACM2, ccmName: 'Neha S' },
    // The sheet's own buckets, written exactly as the workbook writes them.
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
    { smId: '111222-UN', smName: 'Unassigned', tlId: '111222-UN', ccmId: '111222-UN' },
  ]);

  const [july] = await db
    .insert(period)
    .values({
      code: '2026-07',
      label: 'Jul 2026',
      startsOn: '2026-07-01',
      endsOn: '2026-07-31',
      status: 'OPEN',
    })
    .returning({ id: period.id });
  julyId = july.id;

  await policies('ICCSP1', { issued: 7, refused: 2, pending: 1, periodId: julyId });
  await policies('ICCSP2', { issued: 1, refused: 4, periodId: julyId });
  await policies('ICCSP3', { issued: 5, pending: 5, periodId: julyId });
  await policies('ICCSP4', { issued: 3, refused: 3, periodId: julyId });
  await policies('DIY', { issued: 6, pending: 2, periodId: julyId });
  await policies('111222-UN', { issued: 1, periodId: julyId });
  // A code the dump names that the roster has never heard of.
  await policies('ZZ404', { issued: 2, periodId: julyId });
  // A record in no period at all, to prove the period filter narrows.
  await policies('ICCSP1', { issued: 100, periodId: null });

  const tlRow = await makeUser({ role: 'tl', smId: null, tlCode: TL1, email: 'tl@example.test' });
  const acmRow = await makeUser({ role: 'acm', smId: null, acmCode: ACM1, email: 'acm@example.test' });
  const repRow = await makeUser({ role: 'sales', smId: 'ICCSP1', email: 'rep@example.test' });

  tl = session({ id: tlRow.id, role: 'tl', tlCode: TL1 });
  acm = session({ id: acmRow.id, role: 'acm', acmCode: ACM1 });
  rep = session({ id: repRow.id, role: 'sales', smId: 'ICCSP1' });
});

const codes = (rows: Array<{ code: string | null }>) => rows.map((r) => r.code).sort();

describe('who a performance report is about', () => {
  it('shows a team leader their own reps and nobody else', async () => {
    const report = await loadPerformance({ viewer: tl, rung: 'sm', periodId: julyId });

    expect(codes(report.rows)).toEqual(['ICCSP1', 'ICCSP2']);
    // ICCSP3 is under the same area manager but a different team leader;
    // ICCSP4 is another cluster entirely. Either appearing is the failure.
    expect(report.rows.some((r) => r.code === 'ICCSP3')).toBe(false);
    expect(report.rows.some((r) => r.code === 'ICCSP4')).toBe(false);
    expect(report.totals.logins).toBe(15);
  });

  it('shows an area manager every rep across their teams', async () => {
    const report = await loadPerformance({ viewer: acm, rung: 'sm', periodId: julyId });

    expect(codes(report.rows)).toEqual(['ICCSP1', 'ICCSP2', 'ICCSP3']);
    expect(report.rows.some((r) => r.code === 'ICCSP4')).toBe(false);
    expect(report.totals.logins).toBe(25);
  });

  it('groups an area manager by team leader, naming them from the roster', async () => {
    const report = await loadPerformance({ viewer: acm, rung: 'tl', periodId: julyId });

    expect(codes(report.rows)).toEqual([TL1, TL2]);
    const first = report.rows.find((r) => r.code === TL1);
    expect(first?.name).toBe('Sunil P');
    expect(first?.logins).toBe(15);
    expect(report.rows.find((r) => r.code === TL2)?.logins).toBe(10);
  });

  it('shows a rep only themselves', async () => {
    const report = await loadPerformance({ viewer: rep, rung: 'sm', periodId: julyId });

    expect(codes(report.rows)).toEqual(['ICCSP1']);
    expect(report.totals.logins).toBe(10);
  });

  it('refuses a manager account whose roster code was never filled in', async () => {
    const broken = session({ id: tl.id, role: 'tl', tlCode: null });
    await expect(loadPerformance({ viewer: broken, rung: 'sm' })).rejects.toBeInstanceOf(AuthzError);
  });

  it('moves a rep and their policies when an admin overrides the roster', async () => {
    await db.insert(manpowerOverride).values({
      smId: 'ICCSP4',
      tlId: TL1,
      ccmId: ACM1,
      reason: 'moved for the test',
      overriddenBy: admin.id,
    });

    const report = await loadPerformance({ viewer: tl, rung: 'sm', periodId: julyId });
    expect(codes(report.rows)).toEqual(['ICCSP1', 'ICCSP2', 'ICCSP4']);

    // And at the manager rung the six policies count on TL1, not on TL3.
    const byTl = await loadPerformance({ viewer: admin, rung: 'tl', periodId: julyId });
    expect(byTl.rows.find((r) => r.code === TL1)?.logins).toBe(21);
    expect(byTl.rows.some((r) => r.code === TL3)).toBe(false);
  });
});

describe('the figures themselves', () => {
  it('keeps issued + refused + pending equal to logins, always', async () => {
    for (const rung of ['sm', 'tl', 'acm'] as const) {
      const report = await loadPerformance({ viewer: admin, rung, periodId: julyId });
      for (const row of [...report.rows, ...report.placeholders]) {
        expect(row.issued + row.refused + row.pending).toBe(row.logins);
      }
      expect(report.totals.issued + report.totals.refused + report.totals.pending).toBe(
        report.totals.logins,
      );
    }
  });

  it('counts a status it has no name for rather than losing it', async () => {
    await policies('ICCSP1', { stray: 3, periodId: julyId });

    const report = await loadPerformance({ viewer: rep, rung: 'sm', periodId: julyId });
    const [row] = report.rows;

    expect(row.logins).toBe(13);
    expect(row.issued).toBe(7);
    expect(row.refused).toBe(2);
    // It lands in pending — the invariant holds — and `unclassified` is what
    // makes the discrepancy visible instead of it reading as pending business.
    expect(row.pending).toBe(4);
    expect(row.issued + row.refused + row.pending).toBe(row.logins);
    expect(row.unclassified).toBe(3);
    expect(report.totals.unclassified).toBe(3);
  });

  it('sums ANP and FP exactly, as strings', async () => {
    const report = await loadPerformance({ viewer: rep, rung: 'sm', periodId: julyId });

    // 10 policies at 100.00 — a string from Postgres, never a float.
    expect(report.totals.anp).toBe('1000.00');
    expect(report.totals.fp).toBe('100.00');
    expect(typeof report.rows[0].anp).toBe('string');
  });

  it('narrows to one period, and widens when asked for none', async () => {
    const scoped = await loadPerformance({ viewer: rep, rung: 'sm', periodId: julyId });
    const everything = await loadPerformance({ viewer: rep, rung: 'sm', periodId: null });

    expect(scoped.totals.logins).toBe(10);
    // The extra hundred belong to no period at all and only appear unfiltered.
    expect(everything.totals.logins).toBe(110);
  });
});

describe('the placeholder buckets', () => {
  it('keeps DIY and 111222-UN out of the ranking and inside the totals', async () => {
    const report = await loadPerformance({ viewer: admin, rung: 'sm', periodId: julyId });

    expect(report.rows.some((r) => r.placeholder)).toBe(false);
    expect(codes(report.placeholders)).toEqual(['111222-UN', 'DIY']);
    expect(report.placeholders.find((r) => r.code === 'DIY')?.logins).toBe(8);

    // 10 + 5 + 10 + 6 (real reps) + 2 (ZZ404) + 9 (the two buckets) = 42.
    expect(report.totals.logins).toBe(42);
    const ranked = report.rows.reduce((n, r) => n + r.logins, 0);
    const bucketed = report.placeholders.reduce((n, r) => n + r.logins, 0);
    expect(ranked + bucketed).toBe(report.totals.logins);
  });

  it('never invents a team leader called DIY', async () => {
    const report = await loadPerformance({ viewer: admin, rung: 'tl', periodId: julyId });

    expect(report.rows.some((r) => r.code === 'DIY')).toBe(false);
    expect(report.rows.some((r) => r.code === '111222-UN')).toBe(false);
    // The sheet names DIY as its own team leader; grouping on it verbatim is the
    // failure this asserts against. The bucket keeps its own row instead.
    expect(report.placeholders.reduce((n, r) => n + r.logins, 0)).toBe(9);
  });

  it('keeps a code the roster has never seen as an unplaced row, not a person', async () => {
    const report = await loadPerformance({ viewer: admin, rung: 'tl', periodId: julyId });

    const unplaced = report.rows.find((r) => r.code === null);
    expect(unplaced?.logins).toBe(2);
    // Last whatever its size: it is a gap to close, not a competitor.
    expect(report.rows[report.rows.length - 1].code).toBeNull();
  });
});

describe("a rep's standing in their team", () => {
  it('gives the rep their own numbers and the team as an aggregate', async () => {
    const standing = await loadRepStanding(rep, julyId);

    expect(standing.tlId).toBe(TL1);
    expect(standing.tlName).toBe('Sunil P');
    expect(standing.own.logins).toBe(10);
    // ICCSP1 + ICCSP2, and nothing from TL2 or TL3.
    expect(standing.team.logins).toBe(15);
    expect(standing.teamSize).toBe(2);
  });

  it('counts a team member who logged nothing at all', async () => {
    await db
      .insert(manpower)
      .values({ smId: 'ICCSP5', smName: 'Rep Five', tlId: TL1, ccmId: ACM1 });

    const standing = await loadRepStanding(rep, julyId);
    // Three on the roster, two with business. An average taken over the two
    // would flatter the team by leaving the idle rep out of the denominator.
    expect(standing.teamSize).toBe(3);
    expect(standing.team.logins).toBe(15);
  });

  it('refuses an account with no SM_ID rather than reporting on everybody', async () => {
    const broken = session({ id: rep.id, role: 'sales', smId: null });
    await expect(loadRepStanding(broken)).rejects.toBeInstanceOf(AuthzError);
  });
});
