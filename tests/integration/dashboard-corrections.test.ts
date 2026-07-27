import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { correctionRequest, salesRecord } from '@/db/schema';
import {
  countCorrections,
  listCorrections,
  parseCorrectionFilters,
} from '@/app/admin/corrections/query';
import { makeUser, truncateAll } from '../helpers/db';

/** The whole list, unpaged — the fixture is small on purpose. */
const ALL = { limit: 100, offset: 0 };

const REP_A = 'C2CM00001';
const REP_B = 'C2CM00002';

async function fetchAppsNos(params: Record<string, string | string[] | undefined>) {
  const filters = parseCorrectionFilters(params);
  const rows = await listCorrections(filters, ALL);
  return rows.map((row) => row.appsNo).sort();
}

describe('admin corrections filters (spec 9)', () => {
  beforeEach(async () => {
    await truncateAll();

    const repA = await makeUser({ role: 'sales', smId: REP_A, email: 'rep.a@example.test' });
    const repB = await makeUser({ role: 'sales', smId: REP_B, email: 'rep.b@example.test' });
    const approver = await makeUser({ role: 'approver', email: 'approver@example.test' });

    const records = await db
      .insert(salesRecord)
      .values(
        ['5920000001', '5920000002', '5920000003', '6160000004', '6160000005'].map((appsNo) => ({
          appsNo,
          smId: appsNo.startsWith('592') ? REP_A : REP_B,
          status: 'ISSUED',
          issuedDate: '2026-06-03',
          policyNo: null,
          autopay: null,
        })),
      )
      .returning();

    const byAppsNo = new Map(records.map((row) => [row.appsNo, row]));
    const at = (iso: string) => new Date(`${iso}T09:30:00.000Z`);

    await db.insert(correctionRequest).values([
      {
        recordId: byAppsNo.get('5920000001')!.id,
        appsNo: '5920000001',
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: repA.id,
        smId: REP_A,
        status: 'PENDING',
        submittedAt: at('2026-07-01'),
      },
      {
        recordId: byAppsNo.get('5920000002')!.id,
        appsNo: '5920000002',
        category: 'ISSUANCE_DATE',
        fieldName: 'issuedDate',
        fieldLabel: 'Issued date',
        proposedValue: '2026-06-10',
        submittedBy: repA.id,
        smId: REP_A,
        status: 'APPROVED',
        reviewedBy: approver.id,
        reviewedAt: at('2026-07-03'),
        submittedAt: at('2026-07-02'),
      },
      {
        recordId: byAppsNo.get('5920000003')!.id,
        appsNo: '5920000003',
        category: 'OTHERS',
        fieldName: 'clientName',
        fieldLabel: 'Client name',
        proposedValue: 'Corrected Name',
        description: 'Misspelt at data entry',
        submittedBy: repA.id,
        smId: REP_A,
        status: 'REJECTED',
        reviewedBy: approver.id,
        reviewedAt: at('2026-07-16'),
        submittedAt: at('2026-07-15'),
      },
      {
        recordId: byAppsNo.get('6160000004')!.id,
        appsNo: '6160000004',
        category: 'MAPPING',
        fieldName: 'smId',
        fieldLabel: 'SM ID',
        proposedValue: REP_B,
        submittedBy: repB.id,
        smId: REP_B,
        status: 'PENDING',
        submittedAt: at('2026-07-15'),
      },
      {
        recordId: byAppsNo.get('6160000005')!.id,
        appsNo: '6160000005',
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: repB.id,
        smId: REP_B,
        status: 'RETURNED',
        reviewedBy: approver.id,
        reviewedAt: at('2026-07-21'),
        submittedAt: at('2026-07-20'),
        resubmissionCount: 1,
      },
    ]);
  });

  it('returns every request, in any state, when nothing is filtered', async () => {
    const filters = parseCorrectionFilters({});
    expect(await countCorrections(filters)).toBe(5);
    expect(await listCorrections(filters, ALL)).toHaveLength(5);
  });

  it('filters by status', async () => {
    expect(await fetchAppsNos({ status: 'PENDING' })).toEqual(['5920000001', '6160000004']);
    expect(await fetchAppsNos({ status: 'RETURNED' })).toEqual(['6160000005']);
  });

  it('filters by category', async () => {
    expect(await fetchAppsNos({ category: 'AUTOPAY' })).toEqual(['5920000001', '6160000005']);
    expect(await fetchAppsNos({ category: 'MAPPING' })).toEqual(['6160000004']);
  });

  it('filters by SM_ID, case-insensitively', async () => {
    const upper = await fetchAppsNos({ smId: REP_B });
    expect(upper).toEqual(['6160000004', '6160000005']);
    // Six reps appear in both cases in the source file (section 6.3); a
    // lowercase filter must not silently return nothing.
    expect(await fetchAppsNos({ smId: REP_B.toLowerCase() })).toEqual(upper);
  });

  it('filters by an inclusive date range', async () => {
    expect(await fetchAppsNos({ from: '2026-07-15' })).toEqual([
      '5920000003',
      '6160000004',
      '6160000005',
    ]);
    expect(await fetchAppsNos({ to: '2026-07-02' })).toEqual(['5920000001', '5920000002']);
    expect(await fetchAppsNos({ from: '2026-07-01', to: '2026-07-02' })).toEqual([
      '5920000001',
      '5920000002',
    ]);
  });

  it('includes requests raised during the final day of the range', async () => {
    // submitted_at is a timestamp, so an inclusive upper bound compared against
    // midnight would return nothing at all here.
    expect(await fetchAppsNos({ from: '2026-07-15', to: '2026-07-15' })).toEqual([
      '5920000003',
      '6160000004',
    ]);
  });

  it('searches Apps_No by substring', async () => {
    expect(await fetchAppsNos({ q: '616' })).toEqual(['6160000004', '6160000005']);
    expect(await fetchAppsNos({ q: '0000002' })).toEqual(['5920000002']);
  });

  it('treats a LIKE wildcard in the search box as a literal', async () => {
    // An unescaped "%" would match every request and look like a working search.
    expect(await fetchAppsNos({ q: '%' })).toEqual([]);
    expect(await fetchAppsNos({ q: '_' })).toEqual([]);
  });

  it('combines filters', async () => {
    expect(await fetchAppsNos({ status: 'PENDING', smId: REP_A })).toEqual(['5920000001']);
    expect(await fetchAppsNos({ category: 'AUTOPAY', status: 'RETURNED' })).toEqual(['6160000005']);
  });

  it('ignores a filter value the database does not know, rather than failing', async () => {
    // Comparing correction_status to a hand-typed value raises "invalid input
    // value for enum" in Postgres, so an unvalidated parameter would be a 500.
    const filters = parseCorrectionFilters({ status: 'NONSENSE', category: 'NOPE', from: 'soon' });
    expect(filters.status).toBeNull();
    expect(filters.category).toBeNull();
    expect(filters.from).toBeNull();
    expect(await countCorrections(filters)).toBe(5);
  });

  it('pages without losing or repeating a request', async () => {
    const filters = parseCorrectionFilters({});
    const first = await listCorrections(filters, { limit: 2, offset: 0 });
    const second = await listCorrections(filters, { limit: 2, offset: 2 });
    const third = await listCorrections(filters, { limit: 2, offset: 4 });

    const ids = [...first, ...second, ...third].map((row) => row.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it('carries the submitter, the reviewer and the resubmission count for display', async () => {
    const [row] = await listCorrections(parseCorrectionFilters({ status: 'RETURNED' }), ALL);

    expect(row.submitterEmail).toBe('rep.b@example.test');
    expect(row.reviewerName).not.toBeNull();
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(row.resubmissionCount).toBe(1);
  });

  it('orders newest first, so the most recent activity is on page one', async () => {
    const rows = await listCorrections(parseCorrectionFilters({}), ALL);
    const times = rows.map((row) => row.submittedAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});
