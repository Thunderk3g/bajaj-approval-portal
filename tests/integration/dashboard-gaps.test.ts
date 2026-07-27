import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { salesRecord, uploadBatch, uploadBatchRow } from '@/db/schema';
import { getAdminDashboard } from '@/lib/dashboard/admin';
import { GAP_TYPES, detectGaps, hasGap, isAnomalous } from '@/lib/records/gaps';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The dashboard's SQL must agree with detectGaps row for row.
 *
 * Two implementations of the section 6.4 rules exist by necessity — the counts
 * are aggregates and the badges are per row — and the moment they disagree the
 * dashboard misreports the workload the portal exists to clear. So the fixture
 * below mirrors the shape of the June file (blank issuance dates and policy
 * numbers concentrated in PENDING, missing AutoPay everywhere, a couple of
 * ISSUED rows with no policy number) and both implementations are run over it.
 */

type Seed = {
  status: string;
  issuedDate: string | null;
  policyNo: string | null;
  autopay: string | null;
  smId: string;
};

const SEEDS: Seed[] = [
  // ISSUED and complete — nothing to reconcile.
  { status: 'ISSUED', issuedDate: '2026-06-03', policyNo: '9000001', autopay: 'Yes', smId: 'C2CM00004' },
  { status: 'ISSUED', issuedDate: '2026-06-03', policyNo: '9000002', autopay: 'Yes', smId: 'C2CM00004' },
  { status: 'ISSUED', issuedDate: '2026-06-03', policyNo: '9000003', autopay: 'Yes', smId: 'C2CM00004' },

  // Missing AutoPay is the dominant workload: 249 of the 250 gaps in June.
  { status: 'ISSUED', issuedDate: '2026-06-04', policyNo: '9000004', autopay: null, smId: 'C2CM00001' },
  { status: 'ISSUED', issuedDate: '2026-06-04', policyNo: '9000005', autopay: null, smId: 'C2CM00001' },
  // Whitespace is not a value. If an import ever writes "   " instead of NULL,
  // the badge and the count must still agree that the field is missing.
  { status: 'ISSUED', issuedDate: '2026-06-05', policyNo: '9000006', autopay: '   ', smId: 'C2CM00002' },

  // The anomaly of section 6.4: ISSUED with no policy number. Three in June.
  { status: 'ISSUED', issuedDate: '2026-06-06', policyNo: null, autopay: 'Yes', smId: 'C2CM00002' },
  { status: 'ISSUED', issuedDate: '2026-06-07', policyNo: '', autopay: 'Yes', smId: 'C2CM00003' },

  // Does not occur in June — every blank issuance date is PENDING — but it must
  // count if a later file produces one.
  { status: 'ISSUED', issuedDate: null, policyNo: '9000009', autopay: 'Yes', smId: 'C2CM00003' },

  // Status straight from a source column that was never normalized.
  { status: ' issued ', issuedDate: '2026-06-08', policyNo: '9000010', autopay: null, smId: 'C2CM00003' },

  // 105 blank issuance dates and 105 blank policy numbers live on PENDING rows
  // and are entirely correct: an unissued policy has no issuance date.
  { status: 'PENDING', issuedDate: null, policyNo: null, autopay: null, smId: 'C2CM00001' },
  { status: 'PENDING', issuedDate: null, policyNo: null, autopay: null, smId: 'C2CM00001' },
  { status: 'PENDING', issuedDate: null, policyNo: null, autopay: null, smId: 'C2CM00005' },
  { status: 'PENDING', issuedDate: null, policyNo: null, autopay: '', smId: 'C2CM00005' },

  // AutoPay on a rejected application is not actionable.
  { status: 'REJECTED', issuedDate: '2026-06-02', policyNo: '9000020', autopay: null, smId: 'C2CM00005' },
  { status: 'REJECTED', issuedDate: null, policyNo: null, autopay: null, smId: 'C2CM00006' },
];

async function seedRecords() {
  await db.insert(salesRecord).values(
    SEEDS.map((seed, index) => ({
      appsNo: `59200000${String(index).padStart(2, '0')}`,
      policyNo: seed.policyNo,
      smId: seed.smId,
      status: seed.status,
      issuedDate: seed.issuedDate,
      autopay: seed.autopay,
    })),
  );
}

describe('dashboard gap counts against detectGaps (spec 6.4)', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedRecords();
  });

  it('counts exactly what detectGaps flags, row for row', async () => {
    const rows = await db.select().from(salesRecord);
    const { records } = await getAdminDashboard();

    expect(records.total).toBe(rows.length);
    expect(records.withGap).toBe(rows.filter(hasGap).length);
    expect(records.anomalies).toBe(rows.filter(isAnomalous).length);

    for (const type of GAP_TYPES) {
      expect(records.byGap[type], type).toBe(
        rows.filter((row) => detectGaps(row).includes(type)).length,
      );
    }
  });

  it('reports the counts the fixture was built to produce', async () => {
    // Hard-coded as well as cross-checked: if both implementations drifted the
    // same way, the parity assertion above would still pass.
    const { records } = await getAdminDashboard();

    expect(records.total).toBe(16);
    expect(records.issued).toBe(10);
    expect(records.withGap).toBe(7);
    expect(records.anomalies).toBe(2);
    expect(records.byGap).toEqual({
      MISSING_ISSUED_DATE: 1,
      MISSING_POLICY_NO: 2,
      MISSING_AUTOPAY: 4,
    });
  });

  it('counts no gap at all on PENDING or REJECTED rows', async () => {
    // The naive rule would raise 6 false tasks from this fixture alone, and 210
    // from the June file.
    const { records } = await getAdminDashboard();
    const unissued = SEEDS.filter((s) => s.status !== 'ISSUED' && s.status.trim() !== 'issued');

    expect(unissued.length).toBe(6);
    expect(records.total - records.issued).toBe(unissued.length);
    expect(records.withGap).toBeLessThan(records.issued);
  });

  it('spans the right number of reps, so the workload can be shared out', async () => {
    const rows = await db.select().from(salesRecord);
    const expected = new Set(rows.filter(hasGap).map((row) => row.smId));

    const { records } = await getAdminDashboard();
    expect(records.repsWithGap).toBe(expected.size);
    expect(records.repsWithGap).toBe(3);
  });

  it('treats an empty string and whitespace as missing, exactly as detectGaps does', async () => {
    // The rows that would diverge if the SQL used `IS NULL` alone.
    const blankPolicy = await db.select().from(salesRecord);
    const written = blankPolicy.filter((r) => r.policyNo === '' || r.autopay?.trim() === '');
    expect(written.length).toBeGreaterThan(0);

    const { records } = await getAdminDashboard();
    expect(records.byGap.MISSING_POLICY_NO).toBe(
      blankPolicy.filter((row) => detectGaps(row).includes('MISSING_POLICY_NO')).length,
    );
  });
});

describe('admin dashboard batch and duplicate figures (spec 6.6)', () => {
  beforeEach(truncateAll);

  it('counts duplicates in staging, where they are the only place they can exist', async () => {
    // sales_record.apps_no is UNIQUE, so a duplicate never reaches the master
    // table — counting it there would always report zero.
    const admin = await makeUser({ role: 'admin' });

    const [batch] = await db
      .insert(uploadBatch)
      .values({
        originalFileName: "Businesses Dashboard Jun'26.xlsb",
        storedPath: 'uploads/2026/06/test.xlsb',
        fileHash: 'a'.repeat(64),
        status: 'COMMITTED',
        uploadedBy: admin.id,
        committedBy: admin.id,
        committedAt: new Date(),
      })
      .returning();

    await db.insert(uploadBatchRow).values([
      { batchId: batch.id, rowNumber: 1, raw: {}, status: 'VALID' },
      { batchId: batch.id, rowNumber: 2, raw: {}, status: 'DUPLICATE', isDuplicate: true, duplicateOfRow: 1 },
      { batchId: batch.id, rowNumber: 3, raw: {}, status: 'DUPLICATE', isDuplicate: true, duplicateOfRow: 1 },
    ]);

    const data = await getAdminDashboard();

    expect(data.duplicateRows).toBe(2);
    expect(data.batches.total).toBe(1);
    expect(data.batches.committed).toBe(1);
    expect(data.batches.byStatus).toEqual([{ status: 'COMMITTED', count: 1 }]);
    expect(data.batches.lastCommittedAt).toBeInstanceOf(Date);
  });

  it('reports zeroes rather than failing on an empty database', async () => {
    const data = await getAdminDashboard();

    expect(data.records.total).toBe(0);
    expect(data.records.repsWithGap).toBe(0);
    expect(data.batches.byStatus).toEqual([]);
    expect(data.batches.lastCommittedAt).toBeNull();
    expect(data.corrections.pending).toBe(0);
    expect(data.activity).toEqual([]);
  });
});
