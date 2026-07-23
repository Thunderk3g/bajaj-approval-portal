import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, user } from '@/db/schema';
import { AUDIT_ACTIONS } from '@/lib/audit/actions';
import { writeAudit } from '@/lib/audit/log';
import { truncateAll, makeUser, expectDbError } from '../helpers/db';

function actorFrom(row: { id: string; email: string; role: string }) {
  return { id: row.id, email: row.email, role: row.role as 'admin' | 'sales' | 'approver' };
}

async function allRows() {
  return db.select().from(auditLog);
}

describe('AUDIT_ACTIONS', () => {
  it('has no duplicate entries', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});

describe('writeAudit', () => {
  beforeEach(truncateAll);

  it('denormalizes the actor email and role onto the row', async () => {
    const actor = await makeUser({
      role: 'approver',
      smId: null,
      email: 'approver.one@example.test',
    });

    await writeAudit({
      actor: actorFrom(actor),
      action: 'CORRECTION_APPROVE',
      entityType: 'correction_request',
      entityId: 'cr-1',
    });

    const [row] = await allRows();
    expect(row.actorId).toBe(actor.id);
    expect(row.actorEmail).toBe('approver.one@example.test');
    expect(row.actorRole).toBe('approver');
    expect(row.action).toBe('CORRECTION_APPROVE');
    expect(row.entityType).toBe('correction_request');
    expect(row.entityId).toBe('cr-1');
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it('records the before and after jsonb payloads', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await writeAudit({
      actor: actorFrom(actor),
      action: 'RECORD_UPDATE',
      entityType: 'sales_record',
      entityId: 'rec-1',
      before: { payMode: 'CHEQUE', autopay: false, premium: 12500.5 },
      after: { payMode: 'UPI', autopay: true, premium: 12500.5 },
      metadata: { source: 'upload', batchId: 'b-9' },
      ipAddress: '10.1.2.3',
      userAgent: 'vitest',
    });

    const [row] = await allRows();
    expect(row.before).toEqual({ payMode: 'CHEQUE', autopay: false, premium: 12500.5 });
    expect(row.after).toEqual({ payMode: 'UPI', autopay: true, premium: 12500.5 });
    expect(row.metadata).toEqual({ source: 'upload', batchId: 'b-9' });
    expect(row.ipAddress).toBe('10.1.2.3');
    expect(row.userAgent).toBe('vitest');
  });

  it('leaves optional payloads null when they are not supplied', async () => {
    await writeAudit({ actor: null, action: 'EXPORT_GENERATE', entityType: 'excel_export' });

    const [row] = await allRows();
    expect(row.before).toBeNull();
    expect(row.after).toBeNull();
    expect(row.metadata).toBeNull();
    expect(row.entityId).toBeNull();
    expect(row.ipAddress).toBeNull();
    expect(row.userAgent).toBeNull();
  });

  it('accepts a null actor for system-originated actions', async () => {
    await writeAudit({
      actor: null,
      action: 'AUTH_LOGIN_FAILED',
      entityType: 'user',
      entityId: 'unknown@example.test',
      metadata: { reason: 'bad_credentials' },
    });

    const [row] = await allRows();
    expect(row.actorId).toBeNull();
    expect(row.actorEmail).toBeNull();
    expect(row.actorRole).toBeNull();
    expect(row.action).toBe('AUTH_LOGIN_FAILED');
    expect(row.metadata).toEqual({ reason: 'bad_credentials' });
  });

  // Spec section 4.2: users are never hard-deleted, precisely because audit rows
  // reference them. The database enforces that rather than trusting callers.
  it('refuses to delete a user who has audit history', async () => {
    const actor = await makeUser({
      role: 'admin',
      smId: null,
      email: 'departed.admin@example.test',
    });

    await writeAudit({
      actor: actorFrom(actor),
      action: 'USER_DEACTIVATE',
      entityType: 'user',
      entityId: 'someone-else',
    });

    await expectDbError(
      db.delete(user).where(eq(user.id, actor.id)),
      /audit_log_actor_id_user_id_fk|violates foreign key constraint/,
    );

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(actor.id);
  });

  // Deactivation is the sanctioned path, and it leaves the trail fully intact.
  it('keeps the trail readable after the actor is deactivated', async () => {
    const actor = await makeUser({
      role: 'admin',
      smId: null,
      email: 'retired.admin@example.test',
    });

    await writeAudit({
      actor: actorFrom(actor),
      action: 'UPLOAD_COMMIT',
      entityType: 'upload_batch',
      entityId: 'batch-7',
    });

    await db.update(user).set({ isActive: false }).where(eq(user.id, actor.id));

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorEmail).toBe('retired.admin@example.test');
    expect(rows[0].actorRole).toBe('admin');
    expect(rows[0].action).toBe('UPLOAD_COMMIT');
  });

  it('rolls back with the transaction it participates in', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await expect(
      db.transaction(async (tx) => {
        await writeAudit(
          {
            actor: actorFrom(actor),
            action: 'CORRECTION_SUBMIT',
            entityType: 'correction_request',
            entityId: 'cr-rollback',
          },
          tx,
        );
        throw new Error('business rule failed after the audit write');
      }),
    ).rejects.toThrow('business rule failed after the audit write');

    expect(await allRows()).toHaveLength(0);
  });

  it('commits with the transaction it participates in', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });

    await db.transaction(async (tx) => {
      await writeAudit(
        {
          actor: actorFrom(actor),
          action: 'CORRECTION_SUBMIT',
          entityType: 'correction_request',
          entityId: 'cr-commit',
        },
        tx,
      );
    });

    const rows = await allRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe('cr-commit');
  });
});
