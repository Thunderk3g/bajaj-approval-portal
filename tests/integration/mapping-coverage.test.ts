/**
 * The bubble map on its own route — `loadCoverage` with a scope instead of a
 * batch id.
 *
 * `loadBatchCoverage` is unchanged and still has `tests/integration/upload-
 * coverage.test.ts` behind it; what is new is that the same fan-out can be run
 * across every record and narrowed by who is looking. The failure worth testing
 * is the scoping one: an unscoped call from a manager's page would draw them a
 * chart of the whole company's book, which looks exactly like a working chart.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, period, salesRecord, uploadBatch } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { loadBatchCoverage, loadCoverage } from '@/lib/hierarchy/coverage';
import { makeUser, truncateAll } from '../helpers/db';

let admin: SessionUser;
let tl: SessionUser;
let acm: SessionUser;
let rep: SessionUser;
let julyBatch: string;
let augustBatch: string;
let julyId: string;

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

async function policies(batch: string, smId: string, n: number, periodId: string | null) {
  await db.insert(salesRecord).values(
    Array.from({ length: n }, (_, i) => ({
      appsNo: `${batch.slice(0, 8)}-${smId}-${i}`,
      smId,
      sourceBatchId: batch,
      periodId,
      extra: {},
    })),
  );
}

const session = (
  over: Partial<SessionUser> & { id: string; role: SessionUser['role'] },
): SessionUser => ({
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

  const adminRow = await makeUser({ role: 'admin', smId: null });
  admin = session({ id: adminRow.id, role: 'admin' });

  await db.insert(manpower).values([
    { smId: 'ICCSP1', smName: 'Rep One', tlId: 'TL1', tlName: 'Sunil P', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP2', smName: 'Rep Two', tlId: 'TL1', tlName: 'Sunil P', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP3', smName: 'Rep Three', tlId: 'TL2', tlName: 'Meera R', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP4', smName: 'Rep Four', tlId: 'TL3', tlName: 'Ravi N', ccmId: 'ACM2', ccmName: 'Neha S' },
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
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

  julyBatch = await makeBatch(admin.id, 'july.xlsb');
  augustBatch = await makeBatch(admin.id, 'august.xlsb');

  await policies(julyBatch, 'ICCSP1', 3, julyId);
  await policies(julyBatch, 'ICCSP2', 1, julyId);
  await policies(julyBatch, 'ICCSP3', 2, julyId);
  await policies(julyBatch, 'ICCSP4', 1, julyId);
  await policies(julyBatch, 'DIY', 4, julyId);
  await policies(julyBatch, 'ZZ404', 2, julyId);
  // A second upload in no period, so both filters have something to exclude.
  await policies(augustBatch, 'ICCSP1', 5, null);

  const tlRow = await makeUser({ role: 'tl', smId: null, tlCode: 'TL1', email: 'tl@example.test' });
  const acmRow = await makeUser({ role: 'acm', smId: null, acmCode: 'ACM1', email: 'acm@example.test' });
  const repRow = await makeUser({ role: 'sales', smId: 'ICCSP1', email: 'rep@example.test' });

  tl = session({ id: tlRow.id, role: 'tl', tlCode: 'TL1' });
  acm = session({ id: acmRow.id, role: 'acm', acmCode: 'ACM1' });
  rep = session({ id: repRow.id, role: 'sales', smId: 'ICCSP1' });
});

describe('the map across every record', () => {
  it('covers both uploads when nothing narrows it', async () => {
    const coverage = await loadCoverage({ viewer: admin });

    expect(coverage.totals.policies).toBe(18);
    const repOne = coverage.groups
      .flatMap((g) => g.teams)
      .flatMap((t) => t.reps)
      .find((r) => r.smId === 'ICCSP1');
    // 3 in July and 5 in August. The batch chart would say 3.
    expect(repOne?.policies).toBe(8);
  });

  it('narrows to one period', async () => {
    const coverage = await loadCoverage({ viewer: admin, periodId: julyId });
    expect(coverage.totals.policies).toBe(13);
  });

  it('narrows to one upload, agreeing exactly with loadBatchCoverage', async () => {
    const scoped = await loadCoverage({ batchId: julyBatch });
    const batch = await loadBatchCoverage(julyBatch);

    // The old export is now a wrapper; this is what says the wrapper did not
    // change what /admin/uploads/[id] renders.
    expect(scoped).toEqual(batch);
    expect(batch.totals).toMatchObject({ policies: 13, attributed: 7, unattributed: 6 });
  });
});

describe('who the map is drawn for', () => {
  it('gives a team leader only their own team', async () => {
    const coverage = await loadCoverage({ viewer: tl, periodId: julyId });

    expect(coverage.groups).toHaveLength(1);
    const [group] = coverage.groups;
    expect(group.acmId).toBe('ACM1');
    expect(group.teams.map((t) => t.tlId)).toEqual(['TL1']);
    expect(group.teams[0].reps.map((r) => r.smId).sort()).toEqual(['ICCSP1', 'ICCSP2']);
    expect(coverage.totals.policies).toBe(4);

    // The other team under the same area manager must not be on their chart,
    // and neither must the buckets — those belong to nobody's team.
    expect(coverage.groups.flatMap((g) => g.teams).some((t) => t.tlId === 'TL2')).toBe(false);
    expect(coverage.orphans).toEqual([]);
  });

  it('gives an area manager every team beneath them', async () => {
    const coverage = await loadCoverage({ viewer: acm, periodId: julyId });

    expect(coverage.groups).toHaveLength(1);
    expect(coverage.groups[0].teams.map((t) => t.tlId).sort()).toEqual(['TL1', 'TL2']);
    expect(coverage.totals.policies).toBe(6);
    expect(coverage.totals.reps).toBe(3);
  });

  it('gives a rep only themselves', async () => {
    const coverage = await loadCoverage({ viewer: rep, periodId: julyId });

    expect(coverage.totals.policies).toBe(3);
    expect(coverage.groups[0].teams[0].reps.map((r) => r.smId)).toEqual(['ICCSP1']);
  });

  it('refuses a manager whose roster code was never filled in', async () => {
    const broken = session({ id: tl.id, role: 'tl', tlCode: null });
    await expect(loadCoverage({ viewer: broken })).rejects.toBeInstanceOf(AuthzError);
  });
});

describe('the orphan bucket', () => {
  it('stays visible to an administrator — it is the point of the screen', async () => {
    const coverage = await loadCoverage({ viewer: admin, periodId: julyId });

    expect(coverage.orphans).toEqual([
      { smId: 'DIY', policies: 4, placeholder: true },
      { smId: 'ZZ404', policies: 2, placeholder: false },
    ]);
    expect(coverage.totals.unattributed).toBe(6);
    // Counted, and deliberately off the hierarchy: the sheet names DIY as its
    // own team leader and a chart that trusted that would invent a team.
    expect(coverage.groups.flatMap((g) => g.teams).some((t) => t.tlId === 'DIY')).toBe(false);
  });

  it('reports an empty scope as empty rather than failing', async () => {
    await db.delete(salesRecord);
    const coverage = await loadCoverage({ viewer: admin });

    expect(coverage.groups).toEqual([]);
    expect(coverage.orphans).toEqual([]);
    expect(coverage.totals.policies).toBe(0);
  });
});
