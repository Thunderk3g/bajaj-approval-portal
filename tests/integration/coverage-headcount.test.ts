/**
 * The headcount on the mapping screen's header must be a headcount.
 *
 * `loadCoverage` builds a synthetic group keyed `''` for "the roster places this
 * rep under no area manager", and a synthetic team inside a group for "under no
 * team leader". Both are deliberate — they are the not-placed buckets the screen
 * draws — but they are buckets, not people, and counting `groups.length` and
 * `teams.length` reported them as staff: the header read "9 ACMs · 41 TLs" for
 * an org with 8 area managers, and no other number on the page contradicted it.
 *
 * The buckets themselves are asserted here too. A fix that made the totals right
 * by dropping the unplaced reps from the chart would be worse than the bug, and
 * would look identical in the summary line.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, salesRecord } from '@/db/schema';
import { loadCoverage } from '@/lib/hierarchy/coverage';
import { truncateAll } from '../helpers/db';

async function policies(smId: string, n: number) {
  await db.insert(salesRecord).values(
    Array.from({ length: n }, (_, i) => ({
      appsNo: `${smId}-${i}`,
      smId,
      extra: {},
    })),
  );
}

beforeEach(async () => {
  await truncateAll();

  await db.insert(manpower).values([
    // Fully placed: two teams under one area manager.
    { smId: 'ICCSP1', smName: 'Rep One', tlId: 'TL1', tlName: 'Sunil P', ccmId: 'ACM1', ccmName: 'Amit K' },
    { smId: 'ICCSP2', smName: 'Rep Two', tlId: 'TL2', tlName: 'Meera R', ccmId: 'ACM1', ccmName: 'Amit K' },
    // In the cluster, on nobody's team — a synthetic team inside a real group.
    { smId: 'ICCSP3', smName: 'Rep Three', tlId: null, ccmId: 'ACM1', ccmName: 'Amit K' },
    // Under nobody at all — a synthetic team inside a synthetic group.
    { smId: 'ICCSP4', smName: 'Rep Four', tlId: null, ccmId: null },
  ]);

  await policies('ICCSP1', 3);
  await policies('ICCSP2', 2);
  await policies('ICCSP3', 4);
  await policies('ICCSP4', 1);
});

describe('coverage totals count codes, not buckets', () => {
  it('counts one area manager and two team leaders, not two and four', async () => {
    const { totals } = await loadCoverage();

    expect(totals.acms).toBe(1);
    expect(totals.tls).toBe(2);
    // Untouched by the fix, and asserted so a change to one is not quietly a
    // change to the others: every rep is a person the roster names.
    expect(totals.reps).toBe(4);
    expect(totals.policies).toBe(10);
    expect(totals.attributed).toBe(10);
    expect(totals.unattributed).toBe(0);
  });

  it('still draws both not-placed buckets on the chart', async () => {
    const { groups } = await loadCoverage();

    // Two groups on screen — ACM1 and the unplaced one — even though only one
    // of them counts towards the headcount.
    expect(groups.map((g) => g.acmId).sort()).toEqual(['ACM1', null]);

    const real = groups.find((g) => g.acmId === 'ACM1');
    expect(real?.teams.map((t) => t.tlId).sort()).toEqual(['TL1', 'TL2', null]);
    // The rep with no team leader is on the chart with their policies, not
    // dropped to make the count come out.
    expect(real?.teams.find((t) => t.tlId === null)?.reps.map((r) => r.smId)).toEqual(['ICCSP3']);

    const unplaced = groups.find((g) => g.acmId === null);
    expect(unplaced?.teams).toHaveLength(1);
    expect(unplaced?.teams[0].tlId).toBeNull();
    expect(unplaced?.teams[0].reps.map((r) => r.smId)).toEqual(['ICCSP4']);
  });

  it('reports no managers at all when nothing is placed', async () => {
    await db.delete(salesRecord);
    await db.delete(manpower);
    await db.insert(manpower).values([{ smId: 'ICCSP9', smName: 'Rep Nine', tlId: null, ccmId: null }]);
    await policies('ICCSP9', 2);

    const { totals, groups } = await loadCoverage();

    // The degenerate case the old arithmetic got exactly backwards: one bucket
    // holding one rep was reported as "1 ACM · 1 TL".
    expect(totals).toMatchObject({ acms: 0, tls: 0, reps: 1, policies: 2 });
    expect(groups).toHaveLength(1);
  });
});
