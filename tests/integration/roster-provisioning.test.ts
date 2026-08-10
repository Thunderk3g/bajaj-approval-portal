/**
 * Bulk provisioning and roster housekeeping, driven only by the Manpower sheet.
 *
 * The worklist creates accounts at three rungs now, and the rung decides the
 * role, the scoping column and the sign-in address. Getting that wrong is not a
 * cosmetic bug: an area manager provisioned as a rep can see one book instead of
 * a cluster, and a rep provisioned as an area manager can see every book in one.
 * So each assertion below checks the role AND the column it landed in.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, manpower, salesRecord, uploadBatch, user } from '@/db/schema';
import { provisionRosterAccounts, removeRosterEntries } from '@/lib/users/service';
import { listRoster } from '@/lib/users/queries';
import { makeUser, truncateAll } from '../helpers/db';

function actorFrom(row: { id: string; email: string; role: string }) {
  return { id: row.id, email: row.email, role: row.role as 'admin' };
}

let admin: Awaited<ReturnType<typeof makeUser>>;

/**
 * The shapes the July workbook contains, in miniature.
 *
 * ACM001 has no row of its own; TL001 does; JIBL01 names nobody but itself; DIY
 * is a bucket.
 */
beforeEach(async () => {
  await truncateAll();
  admin = await makeUser({ role: 'admin', smId: null });

  await db.insert(manpower).values([
    { smId: 'REP001', smName: 'Ravi Kumar', location: 'Pune', tlId: 'TL001', ccmId: 'ACM001' },
    { smId: 'REP002', smName: 'Asha Rao', location: 'Pune', tlId: 'TL001', ccmId: 'ACM001' },
    { smId: 'TL001', smName: 'Sunil P', location: 'Pune', tlId: 'TL001', ccmId: 'ACM001' },
    { smId: 'JIBL01', smName: 'JIBL', location: 'Mumbai', tlId: 'JIBL01', ccmId: 'JIBL01' },
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
  ]);
});

describe('provisioning from the roster', () => {
  it('creates each rung with its own role, scoping column and address', async () => {
    const result = await provisionRosterAccounts(actorFrom(admin), [
      'acm:ACM001',
      'tl:TL001',
      'sales:REP001',
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.refused).toEqual([]);

    const rows = await db.select().from(user).where(eq(user.isActive, true));
    const byEmail = new Map(rows.map((r) => [r.email, r]));

    const acm = byEmail.get('acm.acm001@bajajlife.com')!;
    expect(acm.role).toBe('acm');
    expect(acm.acmCode).toBe('ACM001');
    // Exactly one code. A second would produce an account `updateUserSchema`
    // refuses to save — one no administrator could ever edit again.
    expect([acm.smId, acm.tlCode]).toEqual([null, null]);

    const tl = byEmail.get('tl.tl001@bajajlife.com')!;
    expect(tl.role).toBe('tl');
    expect(tl.tlCode).toBe('TL001');
    // The name comes off the sheet's own row for the manager, not the code.
    expect(tl.name).toBe('Sunil P');

    const rep = byEmail.get('sm.rep001@bajajlife.com')!;
    expect(rep.role).toBe('sales');
    expect(rep.smId).toBe('REP001');
  });

  it('refuses a rung the sheet does not place, and names why', async () => {
    const result = await provisionRosterAccounts(actorFrom(admin), [
      // REP001 is a rep, not a team leader. A caller can POST anything.
      'tl:REP001',
      'sales:DIY',
      'acm:NOSUCH',
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toEqual([]);
    expect(result.data.refused.map((r) => r.code).sort()).toEqual(['DIY', 'NOSUCH', 'REP001']);
    expect(result.data.refused.find((r) => r.code === 'DIY')!.reason).toMatch(/not a person/i);

    expect(await db.select().from(user).where(eq(user.role, 'tl'))).toEqual([]);
  });

  it('does not reissue a password to somebody who already has an account', async () => {
    await provisionRosterAccounts(actorFrom(admin), ['sales:REP001']);
    const again = await provisionRosterAccounts(actorFrom(admin), ['sales:REP001']);

    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.created).toEqual([]);
    expect(again.data.refused[0].reason).toContain('already has an account');
  });
});

describe('striking an entry off the roster', () => {
  it('removes a code nobody depends on and records what it left behind', async () => {
    const uploader = await makeUser({ role: 'admin', smId: null });
    const [batch] = await db
      .insert(uploadBatch)
      .values({
        originalFileName: "Jul'26.xlsb",
        storedPath: 'uploads/2026/07/x.xlsb',
        fileHash: 'abc',
        uploadedBy: uploader.id,
      })
      .returning();

    // JIBL01 owns business. Removing the roster row must not touch it.
    await db.insert(salesRecord).values({
      appsNo: '5920000001',
      smId: 'JIBL01',
      smName: 'JIBL',
      status: 'ISSUED',
      sourceBatchId: batch.id,
    });

    const result = await removeRosterEntries(actorFrom(admin), ['sales:JIBL01']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removed).toEqual([
      { code: 'JIBL01', rung: 'sales', name: 'JIBL', recordsLeft: 1 },
    ]);

    expect(await db.select().from(manpower).where(eq(manpower.smId, 'JIBL01'))).toEqual([]);
    // The record survives. It is now business nobody on the roster owns, which
    // is what the code meant in the first place.
    expect(await db.select().from(salesRecord).where(eq(salesRecord.smId, 'JIBL01'))).toHaveLength(
      1,
    );

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.entityId, 'JIBL01'));
    expect(entry.action).toBe('ROSTER_ENTRY_DELETE');
    // The row itself, because after the fact there is nothing left to join to.
    expect(entry.before).toMatchObject({ smId: 'JIBL01', smName: 'JIBL' });
    expect(entry.metadata).toMatchObject({ recordsLeft: 1 });

    expect(await listRoster()).not.toContainEqual(expect.objectContaining({ code: 'JIBL01' }));
  });

  it('refuses to strand a team, and refuses a code somebody signs in with', async () => {
    await provisionRosterAccounts(actorFrom(admin), ['sales:REP001']);

    const result = await removeRosterEntries(actorFrom(admin), ['tl:TL001', 'sales:REP001']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.removed).toEqual([]);

    const reasons = new Map(result.data.refused.map((r) => [r.code, r.reason]));
    expect(reasons.get('TL001')).toContain('report to it');
    expect(reasons.get('REP001')).toContain('signs in with this code');

    // Nothing was deleted, including the manager's own row.
    expect(await db.select().from(manpower)).toHaveLength(5);
  });

  it('is safe to submit twice', async () => {
    await removeRosterEntries(actorFrom(admin), ['sales:JIBL01']);
    const again = await removeRosterEntries(actorFrom(admin), ['sales:JIBL01']);

    // The second submission re-reads the roster rather than trusting the page it
    // came from, so it reports an honest miss instead of deleting nothing and
    // calling it a success.
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.removed).toEqual([]);
    expect(again.data.refused[0].reason).toContain('no longer on the worklist');
  });
});
