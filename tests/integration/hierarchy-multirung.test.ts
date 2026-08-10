/**
 * One person, one account, both rungs — the `112224 Sagar Chavan` shape.
 *
 * The sheet writes his code into `ccm_id` for a whole cluster and into `tl_id`
 * for the reps inside it who have no team leader of their own. He is one man, so
 * the roster gives him one entry at his highest rung and provisioning gives him
 * one ACM login.
 *
 * Which leaves the question this suite answers: who signs the TL rung for those
 * reps? `resolveApprover` used to match a stage's rung against its own column,
 * so an ACM account could not answer a TL step and every one of those requests
 * fell to the administrators. It matches by CODE now, and the gap card has to
 * agree with it — a manager the chain already routes to must not be listed as an
 * account waiting to be created.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { manpower } from '@/db/schema';
import { listHierarchyGaps, resolveApprover, resolveHierarchy } from '@/lib/hierarchy/queries';
import { makeUser, truncateAll } from '../helpers/db';

const BOTH = 'BOTH01';

beforeEach(async () => {
  await truncateAll();

  await db.insert(manpower).values([
    // His own row, naming himself at both manager columns, exactly as the
    // workbook writes it.
    { smId: BOTH, smName: 'Sagar Chavan', tlId: BOTH, ccmId: BOTH },
    // A rep with no team leader of their own: the sheet fills tl_id with his code.
    { smId: 'ICCSP0001', smName: 'Rep One', tlId: BOTH, ccmId: BOTH },
    // A rep on a real team inside his cluster.
    { smId: 'ICCSP0002', smName: 'Rep Two', tlId: 'TL001', tlName: 'Sunil P', ccmId: BOTH },
  ]);
});

describe('a code held at two rungs by one account', () => {
  it('answers the TL rung from an ACM login', async () => {
    const sagar = await makeUser({
      role: 'acm',
      name: 'Sagar Chavan',
      email: 'acm.both01@bajajlife.com',
      smId: null,
      acmCode: BOTH,
    });

    const asTl = await resolveApprover('TL', 'ICCSP0001');
    const asAcm = await resolveApprover('ACM', 'ICCSP0001');

    expect(asTl).toEqual({ status: 'RESOLVED', userId: sagar.id, code: BOTH, name: 'Sagar Chavan' });
    // Both rungs are the same man, and both resolve. Before this, the TL rung
    // returned NOT_PROVISIONED and the step opened unassigned.
    expect(asAcm).toEqual(asTl);
  });

  it('still routes a rep who has a team leader of their own to that leader', async () => {
    const sunil = await makeUser({
      role: 'tl',
      name: 'Sunil P',
      email: 'tl.tl001@bajajlife.com',
      smId: null,
      tlCode: 'TL001',
    });
    await makeUser({
      role: 'acm',
      name: 'Sagar Chavan',
      email: 'acm.both01@bajajlife.com',
      smId: null,
      acmCode: BOTH,
    });

    const node = await resolveHierarchy('ICCSP0002');
    expect(node?.tlId).toBe('TL001');

    const asTl = await resolveApprover('TL', 'ICCSP0002');
    expect(asTl).toMatchObject({ status: 'RESOLVED', userId: sunil.id, code: 'TL001' });
  });

  it('does not ask an administrator to create a second login for him', async () => {
    await makeUser({
      role: 'acm',
      name: 'Sagar Chavan',
      email: 'acm.both01@bajajlife.com',
      smId: null,
      acmCode: BOTH,
    });

    const gaps = await listHierarchyGaps();

    // TL001 is a genuine gap — nobody holds that code. BOTH01 is not, at either
    // rung: the chain already routes both of its steps to an account that exists.
    expect(gaps.filter((g) => g.code === BOTH)).toEqual([]);
    expect(gaps.map((g) => `${g.kind}:${g.code}`)).toContain('TL_UNPROVISIONED:TL001');
  });

  it('reports him as unprovisioned while no account holds the code at all', async () => {
    const gaps = await listHierarchyGaps();
    expect(gaps.map((g) => `${g.kind}:${g.code}`).sort()).toEqual([
      'ACM_UNPROVISIONED:BOTH01',
      'TL_UNPROVISIONED:BOTH01',
      'TL_UNPROVISIONED:TL001',
    ]);
  });
});
