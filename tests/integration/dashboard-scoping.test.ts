import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { getSalesDashboard } from '@/lib/dashboard/sales';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The authorization test that matters most (spec section 11): it fails loudly
 * if a future refactor drops the scoping predicate. Every counter on the sales
 * dashboard is checked, not just the headline one — a leak through the gap
 * breakdown would be just as real and far easier to miss.
 */

const REP_A = 'C2CM00001';
const REP_B = 'C2CM00002';

type Row = { status: string; issuedDate: string | null; policyNo: string | null; autopay: string | null };

// Rep A: 4 records, 2 of them carrying a gap.
const A_ROWS: Row[] = [
  { status: 'ISSUED', issuedDate: '2026-06-03', policyNo: '9100001', autopay: 'Yes' },
  { status: 'ISSUED', issuedDate: '2026-06-04', policyNo: '9100002', autopay: null },
  { status: 'ISSUED', issuedDate: '2026-06-05', policyNo: null, autopay: 'Yes' },
  { status: 'PENDING', issuedDate: null, policyNo: null, autopay: null },
];

// Rep B: 5 records, 3 with a gap — deliberately different in every counter, so
// a leak shows up as a wrong number rather than a coincidence.
const B_ROWS: Row[] = [
  { status: 'ISSUED', issuedDate: '2026-06-06', policyNo: '9200001', autopay: null },
  { status: 'ISSUED', issuedDate: '2026-06-07', policyNo: '9200002', autopay: null },
  { status: 'ISSUED', issuedDate: null, policyNo: '9200003', autopay: 'Yes' },
  { status: 'ISSUED', issuedDate: '2026-06-08', policyNo: '9200004', autopay: 'Yes' },
  { status: 'REJECTED', issuedDate: null, policyNo: null, autopay: null },
];

function sessionFor(row: { id: string; email: string; name: string; smId: string | null }): SessionUser {
  return { id: row.id, email: row.email, name: row.name, role: 'sales', smId: row.smId, isActive: true };
}

async function seedRecords(smId: string, rows: Row[], prefix: string) {
  const inserted = await db
    .insert(salesRecord)
    .values(
      rows.map((row, index) => ({
        appsNo: `${prefix}${String(index).padStart(3, '0')}`,
        smId,
        status: row.status,
        issuedDate: row.issuedDate,
        policyNo: row.policyNo,
        autopay: row.autopay,
      })),
    )
    .returning();
  return inserted;
}

describe('sales dashboard scoping (spec 4.1)', () => {
  let repA: Awaited<ReturnType<typeof makeUser>>;
  let repB: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await truncateAll();

    repA = await makeUser({ role: 'sales', smId: REP_A, email: 'rep.a@example.test' });
    repB = await makeUser({ role: 'sales', smId: REP_B, email: 'rep.b@example.test' });

    const aRecords = await seedRecords(REP_A, A_ROWS, '6100');
    const bRecords = await seedRecords(REP_B, B_ROWS, '6200');

    // One request per status for A, and a different mix for B.
    await db.insert(correctionRequest).values([
      {
        recordId: aRecords[1].id,
        appsNo: aRecords[1].appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: repA.id,
        smId: REP_A,
        status: 'PENDING',
      },
      {
        recordId: aRecords[2].id,
        appsNo: aRecords[2].appsNo,
        category: 'ISSUANCE_DATE',
        fieldName: 'issuedDate',
        fieldLabel: 'Issued date',
        proposedValue: '2026-06-05',
        submittedBy: repA.id,
        smId: REP_A,
        status: 'RETURNED',
      },
      {
        recordId: bRecords[0].id,
        appsNo: bRecords[0].appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: repB.id,
        smId: REP_B,
        status: 'PENDING',
      },
      {
        recordId: bRecords[1].id,
        appsNo: bRecords[1].appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: repB.id,
        smId: REP_B,
        status: 'APPROVED',
      },
      {
        recordId: bRecords[2].id,
        appsNo: bRecords[2].appsNo,
        category: 'OTHERS',
        fieldName: 'clientName',
        fieldLabel: 'Client name',
        proposedValue: 'Corrected Name',
        description: 'Name misspelt at data entry',
        submittedBy: repB.id,
        smId: REP_B,
        status: 'REJECTED',
      },
    ]);
  });

  it('reports none of the other rep’s records through any record counter', async () => {
    const a = await getSalesDashboard(sessionFor(repA));

    expect(a.smId).toBe(REP_A);
    expect(a.records.total).toBe(A_ROWS.length);
    expect(a.records.issued).toBe(3);
    expect(a.records.withGap).toBe(2);
    expect(a.records.byGap).toEqual({
      MISSING_ISSUED_DATE: 0,
      MISSING_POLICY_NO: 1,
      MISSING_AUTOPAY: 1,
    });

    // The same figures unscoped would be visibly larger — proof the assertions
    // above are not passing because the fixture is empty.
    const everything = await db.select().from(salesRecord);
    expect(everything.length).toBe(A_ROWS.length + B_ROWS.length);
  });

  it('gives each rep their own numbers, not a shared total', async () => {
    const a = await getSalesDashboard(sessionFor(repA));
    const b = await getSalesDashboard(sessionFor(repB));

    expect(b.records.total).toBe(B_ROWS.length);
    expect(b.records.withGap).toBe(3);
    expect(b.records.byGap).toEqual({
      MISSING_ISSUED_DATE: 1,
      MISSING_POLICY_NO: 0,
      MISSING_AUTOPAY: 2,
    });

    expect(a.records.total + b.records.total).toBe(A_ROWS.length + B_ROWS.length);
    expect(a.records.withGap).not.toBe(b.records.withGap);
  });

  it('counts only the rep’s own correction requests', async () => {
    const a = await getSalesDashboard(sessionFor(repA));
    const b = await getSalesDashboard(sessionFor(repB));

    expect(a.requests).toEqual({ total: 2, pending: 1, approved: 0, rejected: 0, returned: 1 });
    expect(b.requests).toEqual({ total: 3, pending: 1, approved: 1, rejected: 1, returned: 0 });

    const all = await db.select().from(correctionRequest);
    expect(all.length).toBe(5);
  });

  it('shows a rep with no records an empty dashboard rather than everyone else’s', async () => {
    const newcomer = await makeUser({ role: 'sales', smId: 'C2CM09999', email: 'rep.c@example.test' });
    const c = await getSalesDashboard(sessionFor(newcomer));

    expect(c.records.total).toBe(0);
    expect(c.records.withGap).toBe(0);
    expect(c.requests.total).toBe(0);
  });

  it('refuses a caller whose scope would be "no filter"', async () => {
    // scopedRecordCondition returns undefined for an admin. Rendering the sales
    // dashboard for one would count every record in the system as their book.
    const admin = sessionFor({ id: repA.id, email: repA.email, name: repA.name, smId: null });
    await expect(getSalesDashboard({ ...admin, role: 'admin' })).rejects.toThrow(AuthzError);
  });

  it('refuses a sales account with no SM_ID instead of returning everything', async () => {
    const broken = { ...sessionFor(repA), smId: null };
    await expect(getSalesDashboard(broken)).rejects.toThrow(AuthzError);
  });

  it('still scopes after the other rep’s book grows', async () => {
    // A regression that dropped the predicate would only show up once the other
    // rep had more rows than this one.
    await db.insert(salesRecord).values(
      Array.from({ length: 10 }, (_, index) => ({
        appsNo: `63000${String(index).padStart(3, '0')}`,
        smId: REP_B,
        status: 'ISSUED',
        issuedDate: '2026-06-09',
        policyNo: null,
        autopay: null,
      })),
    );

    const a = await getSalesDashboard(sessionFor(repA));
    expect(a.records.total).toBe(A_ROWS.length);

    const bOwned = await db.select().from(salesRecord).where(eq(salesRecord.smId, REP_B));
    expect(bOwned.length).toBe(B_ROWS.length + 10);
  });
});
