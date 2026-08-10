/**
 * The Uploads screen's hierarchy chart, against the real database.
 *
 * Three things it has to get right, and all three are the difference between a
 * chart an admin can act on and a decorative one:
 *
 *  - it counts only the batch it was asked about, not the master table;
 *  - it places a rep by their EFFECTIVE team, so an admin override moves both
 *    the rep and their policies;
 *  - `DIY`, `111222-UN` and codes the roster has never seen are counted and kept
 *    OFF the hierarchy rather than folded into somebody's team.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, manpowerOverride, salesRecord, uploadBatch } from '@/db/schema';
import { loadBatchCoverage } from '@/lib/hierarchy/coverage';
import { makeUser, truncateAll } from '../helpers/db';

let batchId: string;
let otherBatchId: string;

async function makeBatch(uploadedBy: string, fileName: string): Promise<string> {
  const [row] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: fileName,
      storedPath: `uploads/${fileName}`,
      fileHash: fileName,
      uploadedBy,
      status: 'COMMITTED',
    })
    .returning({ id: uploadBatch.id });
  return row.id;
}

/** `n` policies for one code in one batch. Apps_No is unique, so it is the counter. */
async function policies(batch: string, smId: string, n: number) {
  await db.insert(salesRecord).values(
    Array.from({ length: n }, (_, i) => ({
      appsNo: `${batch.slice(0, 8)}-${smId}-${i}`,
      smId,
      sourceBatchId: batch,
      extra: {},
    })),
  );
}

beforeEach(async () => {
  await truncateAll();
  const admin = await makeUser({ role: 'admin', smId: null });

  await db.insert(manpower).values([
    { smId: 'ICCSP1', smName: 'Rep One', tlId: 'TL1', tlName: 'Sunil P', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP2', smName: 'Rep Two', tlId: 'TL1', tlName: 'Sunil P', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP3', smName: 'Rep Three', tlId: 'TL2', tlName: 'Meera R', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP4', smName: 'Rep Four', tlId: 'TL3', tlName: 'Ravi N', ccmId: 'ACM2', ccmName: 'Neha S' },
    // As the workbook writes it: its own team leader and its own area manager.
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
  ]);

  // Rep Four has been moved onto Sunil's team by an admin.
  await db.insert(manpowerOverride).values({
    smId: 'ICCSP4',
    tlId: 'TL1',
    ccmId: 'ACM1',
    reason: 'moved for the test',
    overriddenBy: admin.id,
  });

  batchId = await makeBatch(admin.id, 'july.xlsb');
  otherBatchId = await makeBatch(admin.id, 'august.xlsb');

  await policies(batchId, 'ICCSP1', 3);
  await policies(batchId, 'ICCSP2', 1);
  await policies(batchId, 'ICCSP3', 2);
  await policies(batchId, 'ICCSP4', 1);
  await policies(batchId, 'DIY', 4);
  await policies(batchId, 'ZZ404', 2);

  // A second upload, to prove the chart is scoped to one batch.
  await policies(otherBatchId, 'ICCSP1', 5);
});

describe('one upload placed on the hierarchy', () => {
  it('counts only its own batch', async () => {
    const coverage = await loadBatchCoverage(batchId);

    expect(coverage.totals.policies).toBe(13);
    expect(coverage.totals.attributed).toBe(7);
    expect(coverage.totals.unattributed).toBe(6);

    // Rep One sold 3 here and 5 in the other batch. 8 would mean the chart is
    // reading the master table rather than this upload.
    const repOne = coverage.groups[0].teams
      .flatMap((t) => t.reps)
      .find((r) => r.smId === 'ICCSP1');
    expect(repOne?.policies).toBe(3);
  });

  it('fans out area manager → team leader → rep, with the override applied', async () => {
    const coverage = await loadBatchCoverage(batchId);

    expect(coverage.totals).toMatchObject({ acms: 1, tls: 2, reps: 4 });

    const [group] = coverage.groups;
    expect(group.acmId).toBe('ACM1');
    expect(group.acmName).toBe('Amit K');
    expect(group.policies).toBe(7);

    // Biggest first: TL1 carries five of the seven.
    expect(group.teams.map((t) => [t.tlId, t.policies])).toEqual([
      ['TL1', 5],
      ['TL2', 2],
    ]);

    const [tl1] = group.teams;
    expect(tl1.tlName).toBe('Sunil P');
    // Rep Four counts on Sunil's team, not on TL3/ACM2 where the sheet puts them.
    expect(Object.fromEntries(tl1.reps.map((r) => [r.smId, r.policies]))).toEqual({
      ICCSP1: 3,
      ICCSP2: 1,
      ICCSP4: 1,
    });
    expect(coverage.groups.some((g) => g.acmId === 'ACM2')).toBe(false);
  });

  it('keeps the buckets and the unknown codes off the chart but in the total', async () => {
    const coverage = await loadBatchCoverage(batchId);

    expect(coverage.orphans).toEqual([
      { smId: 'DIY', policies: 4, placeholder: true },
      { smId: 'ZZ404', policies: 2, placeholder: false },
    ]);

    // The sheet carries a DIY row naming DIY as its own team leader; if the
    // fan-out ever trusted that, this is the assertion that fails.
    expect(coverage.groups.flatMap((g) => g.teams).some((t) => t.tlId === 'DIY')).toBe(false);
  });

  it('reports an empty batch as empty rather than failing', async () => {
    const coverage = await loadBatchCoverage(otherBatchId);
    expect(coverage.totals.policies).toBe(5);

    const admin = await makeUser({ role: 'admin', smId: null, email: 'second@example.test' });
    const empty = await loadBatchCoverage(await makeBatch(admin.id, 'empty.xlsb'));
    expect(empty.groups).toEqual([]);
    expect(empty.orphans).toEqual([]);
    expect(empty.totals).toEqual({
      policies: 0,
      attributed: 0,
      unattributed: 0,
      acms: 0,
      tls: 0,
      reps: 0,
    });
  });
});
