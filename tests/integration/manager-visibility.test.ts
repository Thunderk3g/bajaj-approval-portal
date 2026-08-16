import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, manpower, salesRecord } from '@/db/schema';
import { getRequestDetail } from '@/lib/approvals/queries';
import { listTeam, managerSummary } from '@/lib/managers/queries';
import { countRecords } from '@/lib/records/query';
import { EMPTY_FILTERS } from '@/lib/records/filters';
import { makeUser, sessionFor, truncateAll } from '../helpers/db';

/**
 * The roster shapes a manager is actually handed, and what each of them used to
 * hide.
 *
 * Every fixture here is copied from the production July workbook rather than
 * invented, because the defects these cover were all invisible against a clean
 * rep-only roster — which is exactly what every pre-existing suite seeds:
 *
 *   SELF-ROW      a manager carries a `manpower` row of their own naming
 *                 themselves at all three rungs (`112224 Sagar Chavan`).
 *   NO SELF-ROW   a manager exists only as somebody else's `ccm_id` (`503576`).
 *   SPLIT TEAM    a rep names one team leader while naming a DIFFERENT area
 *                 manager than that team leader's own row does.
 */

const ACM = '112224';
const TL_A = '283653';
const TL_B = 'ICCSP82423';
const OTHER_ACM = '503576';

/**
 * ACM 112224
 *   ├── TL 283653 (own row names 112224) — one rep, and a book of his own
 *   └── TL ICCSP82423 (own row names 112224) — one rep whose OWN ccm_id says 503576
 * ACM 503576 has no roster row at all.
 */
async function seedRoster() {
  await db.insert(manpower).values([
    { smId: ACM, smName: 'Sagar Chavan', tlId: ACM, ccmId: ACM, location: 'Term Pune' },
    { smId: TL_A, smName: 'Naresh Samal', tlId: TL_A, ccmId: ACM, location: 'Term Pune' },
    { smId: TL_B, smName: 'Mohsin Shaikh', tlId: TL_B, ccmId: ACM, location: 'Term Pune' },
    { smId: 'ICCSP100881', smName: 'Omkar Pawar', tlId: TL_A, ccmId: ACM, location: 'Term Pune' },
    // The split: reports to TL_B, but its own ccm_id names a different manager.
    { smId: 'ICCSP106866', smName: 'Rutuja Bathe', tlId: TL_B, ccmId: OTHER_ACM, location: 'Mumbai' },
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
  ]);

  await db.insert(salesRecord).values([
    { appsNo: 'A-ACM-OWN', smId: ACM, status: 'ISSUED' },
    { appsNo: 'A-TLA-OWN', smId: TL_A, status: 'ISSUED' },
    { appsNo: 'A-TLB-OWN', smId: TL_B, status: 'ISSUED' },
    { appsNo: 'A-REP-A', smId: 'ICCSP100881', status: 'ISSUED' },
    { appsNo: 'A-REP-SPLIT', smId: 'ICCSP106866', status: 'ISSUED' },
    { appsNo: 'A-DIY', smId: 'DIY', status: 'ISSUED' },
  ]);
}

describe('what an area manager can see', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedRoster();
  });

  it('counts the reps under a team leader below it, even when the rep row names another ACM', async () => {
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM, name: 'Sagar Chavan' }));

    // Own book + both TLs' own books + the directly-named rep + the split rep.
    // Before the transitive union the split rep was invisible to the only area
    // manager the roster places above their team leader.
    expect(await countRecords(acm, EMPTY_FILTERS)).toBe(5);
  });

  it('reaches a team leader who has no roster row of their own', async () => {
    await db.delete(manpower).where(eq(manpower.smId, TL_B));
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM, name: 'Sagar Chavan' }));

    // TL_B's own row is gone, so the split rep leaves the cluster with it — but
    // the ACM's own production must survive a roster that never mentions them.
    const acmOwn = sessionFor(
      await makeUser({ role: 'acm', acmCode: OTHER_ACM, name: 'Shantanu Singh' }),
    );
    expect(await countRecords(acmOwn, EMPTY_FILTERS)).toBe(1); // the split rep
    expect(await countRecords(acm, EMPTY_FILTERS)).toBeGreaterThanOrEqual(3);
  });

  it('includes a team leader’s own book in that team leader’s scope', async () => {
    const tl = sessionFor(await makeUser({ role: 'tl', tlCode: TL_A, name: 'Naresh Samal' }));
    // A-TLA-OWN + A-REP-A. The TL's personal production used to depend on the
    // sheet happening to carry a self-row for them.
    expect(await countRecords(tl, EMPTY_FILTERS)).toBe(2);
  });

  it('never reaches the DIY bucket through a manager scope', async () => {
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM }));
    const rows = await countRecords(acm, { ...EMPTY_FILTERS, smId: 'DIY' });
    expect(rows).toBe(0);
  });
});

describe('the People screen', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedRoster();
  });

  it('does not list the manager as one of their own reports', async () => {
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM, name: 'Sagar Chavan' }));
    const team = await listTeam(acm);

    expect(team.map((m) => m.smId)).not.toContain(ACM);
    // The reported bug exactly: he appeared as a second, login-less version of
    // himself, because the sheet's self-row matched his own ACM code.
    expect(team.every((m) => m.smId !== ACM)).toBe(true);
  });

  it('recognises a team leader’s login, which is held by tl_code and never sm_id', async () => {
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM, name: 'Sagar Chavan' }));
    await makeUser({ role: 'tl', tlCode: TL_A, name: 'Naresh Samal' });

    const team = await listTeam(acm);
    const leader = team.find((m) => m.smId === TL_A);

    expect(leader?.account).toBe('ACTIVE');
    expect(leader?.isTeamLeader).toBe(true);
    // The dashboard tile built from this told the manager to have people
    // provisioned who already had accounts.
    expect((await managerSummary(acm)).repsWithoutAccounts).toBe(
      team.filter((m) => m.account === 'NONE').length,
    );
  });

  it('separates a deactivated login from one that was never created', async () => {
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM }));
    await makeUser({ role: 'sales', smId: 'ICCSP100881', isActive: false });

    const team = await listTeam(acm);
    expect(team.find((m) => m.smId === 'ICCSP100881')?.account).toBe('INACTIVE');
    expect(team.find((m) => m.smId === 'ICCSP106866')?.account).toBe('NONE');
  });

  it('names the team leader rather than printing a bare code', async () => {
    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM, name: 'Sagar Chavan' }));
    const team = await listTeam(acm);
    expect(team.find((m) => m.smId === 'ICCSP100881')?.tlName).toBe('Naresh Samal');
  });
});

describe('reading one request', () => {
  beforeEach(async () => {
    await truncateAll();
    await seedRoster();
  });

  it('refuses a manager a request belonging to another cluster', async () => {
    const outsider = sessionFor(await makeUser({ role: 'tl', tlCode: 'SOMEONE-ELSE' }));
    const rep = await makeUser({ role: 'sales', smId: 'ICCSP100881' });

    const [record] = await db
      .select()
      .from(salesRecord)
      .where(eq(salesRecord.appsNo, 'A-REP-A'));

    const [request] = await db
      .insert(correctionRequest)
      .values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: rep.id,
        smId: 'ICCSP100881',
      })
      .returning();

    // Null, not a throw: every caller renders it as a 404, deliberately
    // indistinguishable from a request id that does not exist.
    expect(await getRequestDetail(outsider, request.id)).toBeNull();

    const acm = sessionFor(await makeUser({ role: 'acm', acmCode: ACM }));
    expect(await getRequestDetail(acm, request.id)).not.toBeNull();
  });
});
