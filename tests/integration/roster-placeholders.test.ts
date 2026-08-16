/**
 * The Manpower sheet's bucket codes must not surface anywhere that offers an
 * action on a person.
 *
 * `111222-UN` (the source's marker for a lead nobody has been given) and `DIY`
 * (the digital channel) are rows on the sheet like any other, and each names
 * ITSELF as its own team leader and area manager. Every screen that asked "is
 * this on the roster?" therefore said yes: the provisioning worklist offered them
 * as reps to create logins for, the tree grew a one-person team for each, and the
 * gap card listed four manager codes without accounts — none of which can ever be
 * cleared, because provisioning refuses to give a bucket a login.
 *
 * One shared predicate covers all of it (src/lib/roster/placeholders.ts). This
 * fixture is the real pair, exactly as the July workbook writes them, so a filter
 * dropped from any one of these reads fails here rather than in front of an
 * administrator.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { loadHierarchyTree, loadUnplacedReps } from '@/lib/hierarchy/queries';
import { listHierarchyGaps } from '@/lib/hierarchy/queries';
import { listSmIdOptions } from '@/lib/records/query';
import { listRoster, userCounts } from '@/lib/users/queries';
import { isPlaceholderCode } from '@/lib/roster/placeholders';
import { makeUser, truncateAll } from '../helpers/db';

describe('the sheet rows that are not people', () => {
  beforeEach(async () => {
    await truncateAll();

    await db.insert(manpower).values([
      // Self-referential, as the workbook writes them.
      { smId: '111222-UN', smName: 'DIY', tlId: '111222-UN', ccmId: '111222-UN' },
      { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
      // One real rep, so an empty result cannot pass these assertions.
      { smId: 'C2CM21350', smName: 'Ravi Kumar', tlId: 'TL001', tlName: 'Sunil P', ccmId: 'CCM001' },
    ]);
  });

  it('recognises both, in either case and with padding', () => {
    expect(isPlaceholderCode('DIY')).toBe(true);
    expect(isPlaceholderCode(' diy ')).toBe(true);
    expect(isPlaceholderCode('111222-un')).toBe(true);
    expect(isPlaceholderCode('C2CM21350')).toBe(false);
    expect(isPlaceholderCode(null)).toBe(false);
  });

  it('keeps them off the provisioning worklist, at every rung', async () => {
    const roster = await listRoster();

    // The rep, plus the two manager codes their row names. The buckets name
    // themselves at all three rungs and appear at none of them.
    expect(roster.map((r) => `${r.rung}:${r.code}`)).toEqual([
      'acm:CCM001',
      'tl:TL001',
      'sales:C2CM21350',
    ]);
    expect(roster.some((r) => isPlaceholderCode(r.code))).toBe(false);

    // The count under the worklist has to agree with it, or the tab badge
    // promises work the list does not show.
    expect((await userCounts()).unprovisioned).toBe(3);
  });

  it('keeps them out of the tree and off the unplaced list', async () => {
    const teams = await loadHierarchyTree();
    expect(teams.map((t) => t.tlId)).toEqual(['TL001']);
    expect(teams[0].reps.map((r) => r.smId)).toEqual(['C2CM21350']);

    expect(await loadUnplacedReps()).toEqual([]);
  });

  it('keeps them out of the records SM_ID filter, which reads the roster not the dump', async () => {
    // The login dump names both buckets and a code the roster has never carried.
    // Every one of them used to reach the dropdown, because it was a distinct
    // scan of `sales_record.sm_id` — a column of codes, not a list of people.
    await db.insert(salesRecord).values([
      { appsNo: '6167509001', smId: 'DIY', smName: 'DIY', extra: {} },
      { appsNo: '6167509002', smId: '111222-UN', extra: {} },
      { appsNo: '6167509003', smId: 'ZZ404', smName: 'Gone From Sheet', extra: {} },
      { appsNo: '6167509004', smId: 'C2CM21350', smName: 'Ravi Kumar', extra: {} },
    ]);

    const row = await makeUser({ role: 'admin', smId: null });
    const admin: SessionUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      role: 'admin',
      smId: null,
      isActive: true,
    };

    expect(await listSmIdOptions(admin)).toEqual([{ smId: 'C2CM21350', smName: 'Ravi Kumar' }]);

    // Still admin-only — a rep must not be handed the register of everyone else.
    expect(await listSmIdOptions({ ...admin, role: 'sales', smId: 'C2CM21350' })).toEqual([]);
  });

  it('does not report them as manager codes waiting for a login', async () => {
    const gaps = await listHierarchyGaps();

    // TL001 and CCM001 are real and unprovisioned; the four bucket rungs are not
    // listed at all.
    expect(gaps.map((g) => g.code).sort()).toEqual(['CCM001', 'TL001']);
    expect(gaps.every((g) => !isPlaceholderCode(g.code))).toBe(true);
  });
});
