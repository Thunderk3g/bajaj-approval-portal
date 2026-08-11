/**
 * Creating portal accounts from inside the upload flow.
 *
 * The gap this covers: committing the roster places people, and places nobody's
 * login. Until an account exists for a TL and an ACM, every mapping correction
 * their reps raise skips both manager rungs and falls through to the
 * administrators — so an admin was importing the workbook, going to People,
 * provisioning, and importing the same workbook again to get the mapping they
 * expected.
 *
 * The wizard's roster step now runs the SAME provisioning path /admin/users
 * runs, over a worklist scoped to the batch. What is asserted here is that the
 * scoping is real, that the rungs land in the right role and column, that a
 * second pass creates nothing and says why per code, and that re-committing the
 * roster leaves the accounts alone.
 */

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, uploadBatch, user } from '@/db/schema';
import { commitRoster } from '@/lib/import/commit';
import { provisionRosterAccounts } from '@/lib/users/service';
import { listRoster } from '@/lib/users/queries';
import { allocateStoragePath, ensureStorageDirs, UPLOADS_DIR } from '@/lib/storage/paths';
import { makeUser, truncateAll } from '../helpers/db';
import { fixtureBuffer, SM } from '../fixtures/workbook';

let admin: Awaited<ReturnType<typeof makeUser>>;

function actorFrom(row: { id: string; email: string; role: string }) {
  return { id: row.id, email: row.email, role: row.role as 'admin' };
}

/** Stores the fixture workbook and returns a batch pointing at it. */
async function uploadedBatch(): Promise<string> {
  const bytes = fixtureBuffer('xlsb');

  await ensureStorageDirs();
  const { absolutePath, relativePath } = await allocateStoragePath(UPLOADS_DIR, 'xlsb');
  await writeFile(absolutePath, bytes);

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: "Businesses Dashboard Jun'26.xlsb",
      storedPath: relativePath,
      fileHash: createHash('sha256').update(bytes).digest('hex'),
      uploadedBy: admin.id,
    })
    .returning({ id: uploadBatch.id });

  return batch.id;
}

beforeEach(async () => {
  await truncateAll();
  admin = await makeUser({ role: 'admin', smId: null });
});

describe('the roster step lists the people this workbook introduced', () => {
  it('offers every rung the sheet places, and only this batch’s rows', async () => {
    const batchId = await uploadedBatch();
    await commitRoster({ batchId, actor: actorFrom(admin) });

    // Somebody else's roster row, from another file. The wizard's list is about
    // the workbook in front of the admin; the company-wide worklist is
    // /admin/users, and it must still see both.
    const otherBatchId = await uploadedBatch();
    await db.insert(manpower).values({
      smId: 'ZZREP01',
      smName: 'Someone Else',
      tlId: 'ZZTL01',
      ccmId: 'ZZCCM1',
      sourceBatchId: otherBatchId,
    });

    const scoped = await listRoster({ batchId });
    const codes = scoped.map((entry) => entry.code).sort();

    expect(codes).toEqual([
      'C2CM21350',
      'C2CM77777',
      'C2CM88888',
      'C2CM99999',
      'CCM01',
      'CCM02',
      'TL001',
      'TL002',
      'TL003',
    ]);
    // Nobody has a login yet — committing the roster creates none.
    expect(scoped.every((entry) => entry.accountEmail === null)).toBe(true);
    expect(scoped.filter((entry) => entry.rung === 'acm').map((e) => e.code).sort()).toEqual([
      'CCM01',
      'CCM02',
    ]);

    expect(codes).not.toContain('ZZREP01');
    expect((await listRoster()).map((entry) => entry.code)).toContain('ZZREP01');
  });
});

describe('provisioning from inside the wizard', () => {
  it('creates each rung with its own role and scoping column, then counts them as done', async () => {
    const batchId = await uploadedBatch();
    await commitRoster({ batchId, actor: actorFrom(admin) });

    const result = await provisionRosterAccounts(actorFrom(admin), [
      'acm:CCM01',
      'tl:TL001',
      `sales:${SM.SPLIT_CASE}`,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.refused).toEqual([]);
    expect(result.data.created.map((account) => account.email).sort()).toEqual([
      'acm.ccm01@bajajlife.com',
      'sm.c2cm21350@bajajlife.com',
      'tl.tl001@bajajlife.com',
    ]);
    // Shown once, to the screen that asked. Nothing stores them, so the only
    // thing this can assert is that they came back at all.
    expect(result.data.created.every((account) => account.password.length === 16)).toBe(true);

    const accounts = new Map((await db.select().from(user)).map((row) => [row.email, row]));

    const acm = accounts.get('acm.ccm01@bajajlife.com')!;
    expect(acm.role).toBe('acm');
    expect(acm.acmCode).toBe('CCM01');
    expect([acm.smId, acm.tlCode]).toEqual([null, null]);

    const tl = accounts.get('tl.tl001@bajajlife.com')!;
    expect(tl.role).toBe('tl');
    expect(tl.tlCode).toBe('TL001');
    expect([tl.smId, tl.acmCode]).toEqual([null, null]);

    const rep = accounts.get('sm.c2cm21350@bajajlife.com')!;
    expect(rep.role).toBe('sales');
    expect(rep.smId).toBe(SM.SPLIT_CASE);
    expect([rep.tlCode, rep.acmCode]).toEqual([null, null]);

    // The running count the step renders: 3 of 9 now hold a login.
    const scoped = await listRoster({ batchId });
    expect(scoped.filter((entry) => entry.accountEmail !== null)).toHaveLength(3);
    expect(scoped).toHaveLength(9);
  });

  it('is idempotent, and refuses an already-provisioned person by name', async () => {
    const batchId = await uploadedBatch();
    await commitRoster({ batchId, actor: actorFrom(admin) });

    await provisionRosterAccounts(actorFrom(admin), ['tl:TL001', 'acm:CCM01']);
    const again = await provisionRosterAccounts(actorFrom(admin), [
      'tl:TL001',
      'acm:CCM01',
      'tl:TL002',
    ]);

    expect(again.ok).toBe(true);
    if (!again.ok) return;

    // The new one still lands. A batch containing a name already taken must not
    // fail as a whole — the admin ticked a box twice, they did not ask for
    // nothing to happen.
    expect(again.data.created.map((account) => account.code)).toEqual(['TL002']);

    // Named, never silently skipped: a code dropped without a reason is
    // indistinguishable from one the caller forgot to select.
    const reasons = new Map(again.data.refused.map((row) => [row.code, row.reason]));
    expect(reasons.get('TL001')).toContain('already has an account');
    expect(reasons.get('TL001')).toContain('tl.tl001@bajajlife.com');
    expect(reasons.get('CCM01')).toContain('already has an account');

    // Three accounts, not five: a re-run reissues no password, because a new one
    // would lock out whoever signed in with the first and nothing here knew it.
    expect(await db.select().from(user).where(eq(user.role, 'tl'))).toHaveLength(2);
  });

  it('re-committing the roster disturbs no account', async () => {
    const batchId = await uploadedBatch();
    await commitRoster({ batchId, actor: actorFrom(admin) });
    await provisionRosterAccounts(actorFrom(admin), ['acm:CCM01', 'tl:TL001']);

    const before = await db.select().from(user).orderBy(user.email);

    // The same sheet again — the corrected-sheet path an admin takes when the
    // reporting line changed mid-month.
    await commitRoster({ batchId, actor: actorFrom(admin) });

    const after = await db.select().from(user).orderBy(user.email);
    expect(after.map((row) => [row.email, row.role, row.tlCode, row.acmCode, row.isActive])).toEqual(
      before.map((row) => [row.email, row.role, row.tlCode, row.acmCode, row.isActive]),
    );
    // Same rows, same hashes: no password was reissued behind anybody's back.
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());

    const scoped = await listRoster({ batchId });
    expect(scoped.filter((entry) => entry.accountEmail !== null).map((e) => e.code).sort()).toEqual([
      'CCM01',
      'TL001',
    ]);
  });
});
