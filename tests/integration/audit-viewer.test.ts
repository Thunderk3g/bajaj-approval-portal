import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, user } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { auditConditions, distinctEntityTypes, listAuditLog } from '@/app/admin/audit/queries';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

const PAGE = { limit: 25, offset: 0 };

function actorFrom(row: { id: string; email: string; role: string }) {
  return { id: row.id, email: row.email, role: row.role as 'admin' | 'sales' | 'approver' };
}

describe('audit log is append-only (spec 4.6)', () => {
  beforeEach(truncateAll);

  /**
   * Proven, not assumed.
   *
   * The viewer offers no edit or delete affordance, but "the UI does not do it"
   * is not integrity — a compromised session running arbitrary SQL is exactly
   * the threat the trigger exists for. These two assertions are the evidence
   * that the guarantee lives in the database.
   */
  it('rejects an UPDATE against a recorded row', async () => {
    const actor = await makeUser({ role: 'admin', smId: null });
    await writeAudit({
      actor: actorFrom(actor),
      action: 'CORRECTION_APPROVE',
      entityType: 'correction_request',
      entityId: 'cr-1',
    });

    await expectDbError(
      db.update(auditLog).set({ action: 'CORRECTION_REJECT' }).where(eq(auditLog.entityId, 'cr-1')),
      /append-only/i,
    );

    const [row] = await db.select().from(auditLog);
    expect(row.action).toBe('CORRECTION_APPROVE');
  });

  it('rejects a DELETE against a recorded row', async () => {
    const actor = await makeUser({ role: 'admin', smId: null });
    await writeAudit({
      actor: actorFrom(actor),
      action: 'USER_DEACTIVATE',
      entityType: 'user',
      entityId: 'someone',
    });

    await expectDbError(db.delete(auditLog).where(eq(auditLog.entityId, 'someone')), /append-only/i);

    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it('rejects a blanket DELETE with no WHERE clause', async () => {
    const actor = await makeUser({ role: 'admin', smId: null });
    await writeAudit({ actor: actorFrom(actor), action: 'AUTH_LOGIN', entityType: 'user' });

    await expectDbError(db.execute(sql`delete from audit_log`), /append-only/i);

    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});

describe('audit log filtering (spec 5.9)', () => {
  beforeEach(truncateAll);

  async function seed() {
    const admin = await makeUser({ role: 'admin', smId: null, email: 'ada@example.test' });
    const approver = await makeUser({ role: 'approver', smId: null, email: 'bo@example.test' });

    await writeAudit({
      actor: actorFrom(admin),
      action: 'USER_CREATE',
      entityType: 'user',
      entityId: 'u-1',
      after: { role: 'sales', smId: 'C2CM21350' },
    });
    await writeAudit({
      actor: actorFrom(admin),
      action: 'UPLOAD_COMMIT',
      entityType: 'upload_batch',
      entityId: 'b-1',
    });
    await writeAudit({
      actor: actorFrom(approver),
      action: 'CORRECTION_APPROVE',
      entityType: 'correction_request',
      entityId: 'cr-1',
      before: { autopay: null },
      after: { autopay: 'Yes' },
    });

    return { admin, approver };
  }

  it('filters by action', async () => {
    await seed();
    const { rows, total } = await listAuditLog({ action: 'UPLOAD_COMMIT' }, PAGE);
    expect(total).toBe(1);
    expect(rows[0].entityId).toBe('b-1');
  });

  it('filters by actor email substring, matching the value on the row', async () => {
    await seed();
    const { rows, total } = await listAuditLog({ actor: 'bo@' }, PAGE);
    expect(total).toBe(1);
    expect(rows[0].action).toBe('CORRECTION_APPROVE');
  });

  it('filters by entity type and entity id', async () => {
    await seed();
    expect((await listAuditLog({ entityType: 'user' }, PAGE)).total).toBe(1);
    expect((await listAuditLog({ entityId: 'cr-1' }, PAGE)).total).toBe(1);
    expect((await listAuditLog({ entityId: 'nope' }, PAGE)).total).toBe(0);
  });

  it('combines filters conjunctively', async () => {
    const { admin } = await seed();
    const both = await listAuditLog({ actor: admin.email, action: 'USER_CREATE' }, PAGE);
    expect(both.total).toBe(1);

    const contradictory = await listAuditLog(
      { actor: admin.email, action: 'CORRECTION_APPROVE' },
      PAGE,
    );
    expect(contradictory.total).toBe(0);
  });

  it('filters by an inclusive date range in UTC', async () => {
    await seed();
    const today = new Date().toISOString().slice(0, 10);

    expect((await listAuditLog({ from: today, to: today }, PAGE)).total).toBe(3);
    expect((await listAuditLog({ from: '2000-01-01', to: '2000-01-02' }, PAGE)).total).toBe(0);
    expect((await listAuditLog({ from: '2000-01-01' }, PAGE)).total).toBe(3);
  });

  // A hand-edited query string must not be able to error the page out.
  it('ignores an unrecognised action and a malformed date instead of failing', async () => {
    await seed();
    expect(auditConditions({ action: 'DROP_TABLE' })).toBeUndefined();
    expect(auditConditions({ from: 'yesterday', to: '' })).toBeUndefined();
    expect((await listAuditLog({ action: 'DROP_TABLE', from: 'yesterday' }, PAGE)).total).toBe(3);
  });

  it('returns newest first and paginates', async () => {
    await seed();
    const firstPage = await listAuditLog({}, { limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.rows[0].action).toBe('CORRECTION_APPROVE');

    const secondPage = await listAuditLog({}, { limit: 2, offset: 2 });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0].action).toBe('USER_CREATE');
  });

  it('offers only the entity types that exist', async () => {
    await seed();
    expect(await distinctEntityTypes()).toEqual(['correction_request', 'upload_batch', 'user']);
  });

  it('carries the before/after payloads through to the viewer', async () => {
    await seed();
    const { rows } = await listAuditLog({ action: 'CORRECTION_APPROVE' }, PAGE);
    expect(rows[0].before).toEqual({ autopay: null });
    expect(rows[0].after).toEqual({ autopay: 'Yes' });
  });
});

describe('recorded actor survives the user changing (spec 4.6)', () => {
  beforeEach(truncateAll);

  /**
   * The viewer reads actor_email and actor_role off the row and never joins to
   * `user`. A join would rewrite history at read time: rename the account or
   * promote the person, and every line they ever produced would silently claim
   * they were always called that and always held that role.
   */
  it('keeps the email and role captured at the time, after the user is renamed and re-roled', async () => {
    const actor = await makeUser({
      role: 'sales',
      smId: 'C2CM21350',
      email: 'rep.before@example.test',
      name: 'Rep Before',
    });

    await writeAudit({
      actor: actorFrom(actor),
      action: 'CORRECTION_SUBMIT',
      entityType: 'correction_request',
      entityId: 'cr-9',
    });

    await db
      .update(user)
      .set({ email: 'rep.after@example.test', name: 'Rep After', role: 'approver', smId: null })
      .where(eq(user.id, actor.id));

    const { rows } = await listAuditLog({ entityId: 'cr-9' }, PAGE);
    expect(rows[0].actorEmail).toBe('rep.before@example.test');
    expect(rows[0].actorRole).toBe('sales');
    expect(rows[0].actorId).toBe(actor.id);

    // And the filter matches the historical value, not the current one.
    expect((await listAuditLog({ actor: 'rep.before' }, PAGE)).total).toBe(1);
    expect((await listAuditLog({ actor: 'rep.after' }, PAGE)).total).toBe(0);
  });

  it('keeps the trail readable after the actor is deactivated', async () => {
    const actor = await makeUser({ role: 'admin', smId: null, email: 'retired@example.test' });

    await writeAudit({
      actor: actorFrom(actor),
      action: 'UPLOAD_COMMIT',
      entityType: 'upload_batch',
      entityId: 'b-7',
    });

    await db.update(user).set({ isActive: false }).where(eq(user.id, actor.id));

    const { rows } = await listAuditLog({ entityId: 'b-7' }, PAGE);
    expect(rows[0].actorEmail).toBe('retired@example.test');
    expect(rows[0].actorRole).toBe('admin');
  });
});
