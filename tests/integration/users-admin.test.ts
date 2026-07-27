import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, manpower, salesRecord, uploadBatch, user } from '@/db/schema';
import { createUser, setUserActive, updateUser } from '@/lib/users/service';
import { listRoster, listUsers, rosterStatus, userCounts } from '@/lib/users/queries';
import { createUserSchema } from '@/lib/users/schema';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

const PASSWORD = 'correct-horse-battery';

function actorFrom(row: { id: string; email: string; role: string }) {
  return { id: row.id, email: row.email, role: row.role as 'admin' | 'sales' | 'approver' };
}

async function auditFor(entityId: string) {
  return db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
}

describe('creating accounts (spec 4.2)', () => {
  beforeEach(truncateAll);

  it('creates a sales account and records USER_CREATE', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));

    const result = await createUser(admin, {
      name: 'Ravi Kumar',
      email: '  Ravi.Kumar@Example.Test ',
      password: PASSWORD,
      role: 'sales',
      smId: ' c2cm21350 ',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db.select().from(user).where(eq(user.id, result.data.id));
    expect(row.email).toBe('ravi.kumar@example.test');
    expect(row.role).toBe('sales');
    // Uppercased on the way in — the lowercase form would never join to this
    // rep's records.
    expect(row.smId).toBe('C2CM21350');
    expect(row.isActive).toBe(true);

    const [entry] = await auditFor(result.data.id);
    expect(entry.action).toBe('USER_CREATE');
    expect(entry.actorId).toBe(admin.id);
    expect(entry.after).toMatchObject({ role: 'sales', smId: 'C2CM21350' });
    // The password must never reach the trail.
    expect(JSON.stringify(entry.after)).not.toContain(PASSWORD);
  });

  /**
   * The DB CHECK would catch this too, but it surfaces as
   * `violates check constraint "user_sales_requires_sm_id"` — a message that
   * tells the administrator nothing about which box to fill in.
   */
  it('rejects a sales account with no SM_ID, on the field', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));

    const result = await createUser(admin, {
      name: 'No Scope',
      email: 'no.scope@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.smId?.[0]).toMatch(/SM_ID/);

    expect(await db.select().from(user).where(eq(user.email, 'no.scope@example.test'))).toHaveLength(
      0,
    );
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses to give a non-sales account an SM_ID', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));

    const result = await createUser(admin, {
      name: 'Approver One',
      email: 'approver.one@example.test',
      password: PASSWORD,
      role: 'approver',
      smId: 'C2CM21350',
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a duplicate email without writing an audit row', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const input = {
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      password: PASSWORD,
      role: 'sales' as const,
      smId: 'C2CM21350',
    };

    expect((await createUser(admin, input)).ok).toBe(true);

    const before = (await db.select().from(auditLog)).length;
    const second = await createUser(admin, { ...input, email: 'RAVI@example.test' });

    expect(second.ok).toBe(false);
    expect(await db.select().from(auditLog)).toHaveLength(before);
  });

  it('accepts the purely numeric orphan SM_ID from the June data', async () => {
    // 512454 is real (section 13.2 note 7). A rule demanding a letter prefix
    // would lock a live rep out of the system.
    const parsed = createUserSchema.safeParse({
      name: 'Orphan Rep',
      email: 'orphan@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: '512454',
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.smId).toBe('512454');
  });

  it('flags an SM_ID that is not on the roster for review', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    await db.insert(manpower).values({ smId: 'C2CM21350', smName: 'Ravi Kumar' });

    const onRoster = await createUser(admin, {
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: 'C2CM21350',
    });
    const orphan = await createUser(admin, {
      name: 'Unknown Rep',
      email: 'unknown@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: '512454',
    });

    expect(onRoster.ok && orphan.ok).toBe(true);
    if (!onRoster.ok || !orphan.ok) return;

    const [known] = await auditFor(onRoster.data.id);
    const [unknown] = await auditFor(orphan.data.id);

    expect(known.metadata).toMatchObject({ roster: 'roster', needsRosterReview: false });
    expect(unknown.metadata).toMatchObject({ roster: 'absent', needsRosterReview: true });
  });
});

describe('deactivation, never deletion (spec 4.2)', () => {
  beforeEach(truncateAll);

  it('deactivates without removing the row or its audit references', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const created = await createUser(admin, {
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: 'C2CM21350',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await setUserActive(admin, created.data.id, false);
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(user).where(eq(user.id, created.data.id));
    expect(row).toBeDefined();
    expect(row.isActive).toBe(false);
    // The account survives so every audit line still names somebody.
    expect(row.email).toBe('ravi@example.test');

    const entries = await auditFor(created.data.id);
    expect(entries.map((e) => e.action)).toEqual(['USER_CREATE', 'USER_DEACTIVATE']);
    expect(entries[1].before).toMatchObject({ isActive: true });
    expect(entries[1].after).toMatchObject({ isActive: false });
  });

  it('cannot be hard-deleted once the account has audit history', async () => {
    const admin = await makeUser({ role: 'admin', smId: null });
    const created = await createUser(actorFrom(admin), {
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: 'C2CM21350',
    });
    expect(created.ok).toBe(true);

    // ON DELETE RESTRICT on audit_log.actor_id: the admin who performed the
    // action cannot be erased either.
    await expectDbError(
      db.delete(user).where(eq(user.id, admin.id)),
      /violates foreign key constraint|audit_log_actor_id_user_id_fk/,
    );
  });

  it('reactivates, and logs it as an update rather than a deactivation', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const target = await makeUser({ role: 'approver', smId: null, isActive: false });

    expect((await setUserActive(admin, target.id, true)).ok).toBe(true);

    const [row] = await db.select().from(user).where(eq(user.id, target.id));
    expect(row.isActive).toBe(true);

    const entries = await auditFor(target.id);
    expect(entries.map((e) => e.action)).toEqual(['USER_UPDATE']);
  });

  it('writes nothing when the state is already what was asked for', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const target = await makeUser({ role: 'approver', smId: null, isActive: true });

    expect((await setUserActive(admin, target.id, true)).ok).toBe(true);
    expect(await auditFor(target.id)).toHaveLength(0);
  });

  /**
   * Deactivating yourself signs you out on the next request, and if you were
   * the last active admin nobody can undo it: there is no public sign-up and
   * setup:admin refuses to run once any user exists. The only remedy left would
   * be an UPDATE run by hand against the database.
   */
  it('refuses to let an admin deactivate their own account', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));

    const result = await setUserActive(admin, admin.id, false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/your own account/i);

    const [row] = await db.select().from(user).where(eq(user.id, admin.id));
    expect(row.isActive).toBe(true);
    expect(await auditFor(admin.id)).toHaveLength(0);
  });

  it('refuses to let an admin demote themselves', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null, name: 'Only Admin' }));

    const result = await updateUser(admin, {
      userId: admin.id,
      name: 'Only Admin',
      role: 'sales',
      smId: 'C2CM21350',
    });

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(user).where(eq(user.id, admin.id));
    expect(row.role).toBe('admin');
  });

  it('allows deactivating somebody else and reports it in the listing', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const target = await makeUser({ role: 'sales', smId: 'C2CM21350' });

    expect((await setUserActive(admin, target.id, false)).ok).toBe(true);

    const inactive = await listUsers({ active: 'inactive', limit: 25, offset: 0 });
    expect(inactive.total).toBe(1);
    expect(inactive.rows[0].id).toBe(target.id);
  });
});

describe('updating an account (spec 4.2)', () => {
  beforeEach(truncateAll);

  it('records the before and after snapshot on USER_UPDATE', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const target = await makeUser({ role: 'sales', smId: 'C2CM21350', name: 'Old Name' });

    const result = await updateUser(admin, {
      userId: target.id,
      name: 'New Name',
      role: 'sales',
      smId: 'iccsp90766',
    });
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(user).where(eq(user.id, target.id));
    expect(row.name).toBe('New Name');
    expect(row.smId).toBe('ICCSP90766');

    const [entry] = await auditFor(target.id);
    expect(entry.action).toBe('USER_UPDATE');
    expect(entry.before).toMatchObject({ name: 'Old Name', smId: 'C2CM21350' });
    expect(entry.after).toMatchObject({ name: 'New Name', smId: 'ICCSP90766' });
  });

  it('rejects a promotion to sales that leaves the account unscoped', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    const target = await makeUser({ role: 'approver', smId: null });

    const result = await updateUser(admin, {
      userId: target.id,
      name: 'Approver One',
      role: 'sales',
      smId: '',
    });

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(user).where(eq(user.id, target.id));
    expect(row.role).toBe('approver');
  });
});

describe('roster-assisted provisioning (spec 13.2 note 7)', () => {
  beforeEach(truncateAll);

  async function seedRosterAndRecords() {
    const uploader = await makeUser({ role: 'admin', smId: null });
    const [batch] = await db
      .insert(uploadBatch)
      .values({
        originalFileName: "Jun'26.xlsb",
        storedPath: 'uploads/2026/06/x.xlsb',
        fileHash: 'abc',
        uploadedBy: uploader.id,
      })
      .returning();

    await db.insert(manpower).values([
      { smId: 'C2CM21350', smName: 'Ravi Kumar', location: 'Pune' },
      { smId: 'ICCSP90766', smName: 'Asha Rao', location: 'Nagpur' },
    ]);

    // An SM_ID that appears in transaction data but nowhere on the roster.
    await db.insert(salesRecord).values({
      appsNo: '5920000001',
      smId: '512454',
      smName: 'Unknown Rep',
      location: 'Nashik',
      status: 'ISSUED',
      sourceBatchId: batch.id,
    });

    return { uploader };
  }

  it('lists roster IDs and folds in orphans found only in records', async () => {
    await seedRosterAndRecords();

    const roster = await listRoster();
    const bySmId = new Map(roster.map((r) => [r.smId, r]));

    expect([...bySmId.keys()].sort()).toEqual(['512454', 'C2CM21350', 'ICCSP90766']);
    expect(bySmId.get('512454')?.isOrphan).toBe(true);
    expect(bySmId.get('512454')?.smName).toBe('Unknown Rep');
    expect(bySmId.get('C2CM21350')?.isOrphan).toBe(false);
  });

  it('marks which SM_IDs already have an account and sorts those last', async () => {
    const { uploader } = await seedRosterAndRecords();

    const created = await createUser(actorFrom(uploader), {
      name: 'Ravi Kumar',
      email: 'ravi@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: 'C2CM21350',
    });
    expect(created.ok).toBe(true);

    const roster = await listRoster();
    const provisioned = roster.find((r) => r.smId === 'C2CM21350');

    expect(provisioned?.accountEmail).toBe('ravi@example.test');
    expect(provisioned?.accountIsActive).toBe(true);
    // Unprovisioned first, and the orphan ahead of the roster entry.
    expect(roster.map((r) => r.smId)).toEqual(['512454', 'ICCSP90766', 'C2CM21350']);

    const counts = await userCounts();
    expect(counts.unprovisioned).toBe(2);
    expect(counts.sales).toBe(1);
  });

  it('classifies an SM_ID against the roster', async () => {
    await seedRosterAndRecords();
    await db.insert(manpower).values({ smId: 'FLAGGED01', isOrphan: true });

    expect(await rosterStatus('C2CM21350')).toBe('roster');
    expect(await rosterStatus('FLAGGED01')).toBe('orphan');
    expect(await rosterStatus('512454')).toBe('absent');
  });
});
