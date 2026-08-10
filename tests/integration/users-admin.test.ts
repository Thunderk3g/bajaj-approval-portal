import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, manpower, salesRecord, uploadBatch, user } from '@/db/schema';
import { createUser, setUserActive, updateUser } from '@/lib/users/service';
import { listRoster, listUsers, rosterStatus, userCounts } from '@/lib/users/queries';
import { rosterKey } from '@/lib/roster/entries';
import { createUserSchema } from '@/lib/users/schema';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

const PASSWORD = 'correct-horse-battery';

function actorFrom(row: { id: string; email: string; role: string }) {
  return { id: row.id, email: row.email, role: row.role as 'admin' | 'sales' | 'approver' };
}

async function auditFor(entityId: string) {
  return db.select().from(auditLog).where(eq(auditLog.entityId, entityId));
}

/**
 * Places a rep on the roster under a real team leader and area manager.
 *
 * Creating a Sales account now REQUIRES this: the chain resolves a rep's
 * approvers by following `tl_id` and then that team's `ccm_id`, so an account
 * whose code the roster does not place resolves to nobody at both manager rungs
 * and is refused rather than created and flagged. Most tests here only need the
 * account to exist, so they call this first.
 */
async function placeOnRoster(smId: string, smName: string | null = null) {
  await db
    .insert(manpower)
    .values({ smId, smName, tlId: 'TL001', ccmId: 'CCM001', isOrphan: false })
    .onConflictDoUpdate({
      target: manpower.smId,
      set: { tlId: 'TL001', ccmId: 'CCM001', isOrphan: false },
    });
}

describe('creating accounts (spec 4.2)', () => {
  beforeEach(truncateAll);

  it('creates a sales account and records USER_CREATE', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    await placeOnRoster('C2CM21350', 'Ravi Kumar');

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
    await placeOnRoster('C2CM21350', 'Ravi Kumar');
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

  /**
   * Reverses spec 13.2 note 7, deliberately.
   *
   * That rule made an off-roster SM_ID creatable and merely flagged, on the
   * reasoning that the leads are real and the roster sheet lags. It held while an
   * account only scoped a rep to their own records. It stopped holding when the
   * roster also became what ROUTES a correction: such an account resolves to
   * nobody at both manager rungs, so its mapping requests skip the team leader
   * and the area manager and reach the approver signed off by fewer people, with
   * nothing on any screen saying so.
   */
  it('refuses an SM_ID the roster does not carry', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    await placeOnRoster('C2CM21350', 'Ravi Kumar');

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

    expect(onRoster.ok).toBe(true);
    expect(orphan.ok).toBe(false);
    if (!onRoster.ok || orphan.ok) return;

    // The refusal lands on the field the admin has to change, not as a banner.
    expect(orphan.fieldErrors?.smId?.[0]).toMatch(/not on the Manpower roster/i);
    expect(await db.select().from(user).where(eq(user.smId, '512454'))).toHaveLength(0);

    const [known] = await auditFor(onRoster.data.id);
    expect(known.metadata).toMatchObject({ roster: 'roster', needsRosterReview: false });
  });

  it('refuses a rep the roster carries but places under no team leader', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    // The shape `flagOrphans` writes for a code seen in transaction data and
    // absent from the sheet: a row exists, but it places the rep nowhere.
    await db.insert(manpower).values({ smId: 'C2CM99999', isOrphan: true });

    const result = await createUser(admin, {
      name: 'Unplaced Rep',
      email: 'unplaced@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: 'C2CM99999',
    });

    expect(result.ok).toBe(false);
  });

  it('refuses a team leader code nobody reports to', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    await placeOnRoster('C2CM21350', 'Ravi Kumar');

    const result = await createUser(admin, {
      name: 'Ghost Leader',
      email: 'ghost@example.test',
      password: PASSWORD,
      role: 'tl',
      tlCode: 'TL999',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.tlCode?.[0]).toMatch(/no rep on the roster reports/i);

    // TL001 is what placeOnRoster puts everyone under, so it does exist.
    const real = await createUser(admin, {
      name: 'Real Leader',
      email: 'real@example.test',
      password: PASSWORD,
      role: 'tl',
      tlCode: 'TL001',
    });
    expect(real.ok).toBe(true);
  });
});

describe('deactivation, never deletion (spec 4.2)', () => {
  beforeEach(truncateAll);

  it('deactivates without removing the row or its audit references', async () => {
    const admin = actorFrom(await makeUser({ role: 'admin', smId: null }));
    await placeOnRoster('C2CM21350', 'Ravi Kumar');
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
    await placeOnRoster('C2CM21350', 'Ravi Kumar');
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

    // Placed under a real team leader and area manager: an unplaced rep can no
    // longer be given an account at all, so a worklist fixture that left them
    // unplaced would be testing a row nobody can action.
    await db.insert(manpower).values([
      { smId: 'C2CM21350', smName: 'Ravi Kumar', location: 'Pune', tlId: 'TL001', ccmId: 'CCM001' },
      { smId: 'ICCSP90766', smName: 'Asha Rao', location: 'Nagpur', tlId: 'TL001', ccmId: 'CCM001' },
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

  /**
   * The worklist is the Manpower sheet and nothing else, at every rung.
   *
   * It used to fold in SM_IDs found only in `sales_record`, per spec 13.2 note 7.
   * Every reason for that is gone: `flagOrphans` already writes a `manpower` row
   * for such a code at commit, and an account can no longer be created for one
   * that the roster does not place — so those entries were rows whose only button
   * was guaranteed to fail. Roster gaps are named on /admin/hierarchy instead.
   *
   * TL001 and CCM001 are on the list even though the sheet gives them no row of
   * their own: they are the codes it names as the two reps' approvers, and until
   * somebody holds them every mapping correction from this team falls to the
   * administrators.
   */
  it('lists everybody the sheet names, at the rung it puts them on', async () => {
    await seedRosterAndRecords();
    // Both a bucket the sheet carries a row for, and an orphan written by an
    // import: neither can hold a login, so neither belongs on a worklist.
    await db.insert(manpower).values([
      { smId: '111222-UN', smName: 'DIY', tlId: '111222-UN', ccmId: '111222-UN' },
      { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
    ]);

    const roster = await listRoster();

    expect(roster.map(rosterKey)).toEqual([
      'acm:CCM001',
      'tl:TL001',
      'sales:C2CM21350',
      'sales:ICCSP90766',
    ]);
    // 512454 appears only in sales_record; the buckets have roster rows and are
    // excluded by name, at every rung.
    expect(roster.some((r) => r.code === '512454')).toBe(false);
    expect(roster.some((r) => r.code === 'DIY' || r.code === '111222-UN')).toBe(false);
  });

  it('marks which roster codes already have an account and sorts those last', async () => {
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
    const provisioned = roster.find((r) => rosterKey(r) === 'sales:C2CM21350');

    expect(provisioned?.accountEmail).toBe('ravi@example.test');
    expect(provisioned?.accountIsActive).toBe(true);
    // Unprovisioned first, then top of the hierarchy down.
    expect(roster.map(rosterKey)).toEqual([
      'acm:CCM001',
      'tl:TL001',
      'sales:ICCSP90766',
      'sales:C2CM21350',
    ]);

    const counts = await userCounts();
    // The two manager codes and Asha Rao. The record-only 512454 is not counted:
    // there is nothing an admin could do with it from this screen.
    expect(counts.unprovisioned).toBe(3);
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
