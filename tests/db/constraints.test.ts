import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, correctionRequest, salesRecord, user } from '@/db/schema';
import { truncateAll, makeUser, expectDbError } from '../helpers/db';

async function makeRecord(appsNo = '6167509575', smId = 'ICCSP90766') {
  const [row] = await db.insert(salesRecord).values({ appsNo, smId }).returning();
  return row;
}

function openRequestFor(recordId: string, appsNo: string, submittedBy: string) {
  return {
    recordId,
    appsNo,
    category: 'AUTOPAY' as const,
    fieldName: 'autopay',
    fieldLabel: 'AutoPay',
    proposedValue: 'Yes',
    submittedBy,
    smId: 'ICCSP90766',
  };
}

describe('auth schema constraints', () => {
  beforeEach(truncateAll);

  it('creates an admin without an SM_ID', async () => {
    const row = await makeUser({ role: 'admin', smId: null });
    expect(row.role).toBe('admin');
    expect(row.smId).toBeNull();
  });

  it('rejects a sales user with no SM_ID', async () => {
    await expectDbError(
      db.insert(user).values({
        id: randomUUID(),
        name: 'No Scope',
        email: 'noscope@example.test',
        role: 'sales',
        smId: null,
      }),
      /user_sales_requires_sm_id/,
    );
  });

  it('rejects a lowercase SM_ID on a user', async () => {
    await expectDbError(
      db.insert(user).values({
        id: randomUUID(),
        name: 'Lower Case',
        email: 'lower@example.test',
        role: 'sales',
        smId: 'c2cm21350',
      }),
      /user_sm_id_uppercase/,
    );
  });

  it('rejects a duplicate email', async () => {
    await makeUser({ email: 'dupe@example.test' });
    await expectDbError(makeUser({ email: 'dupe@example.test' }), /user_email_unique|duplicate key/);
  });
});

describe('domain constraints', () => {
  beforeEach(truncateAll);

  it('rejects a lowercase SM_ID on a sales record', async () => {
    await expectDbError(
      db.insert(salesRecord).values({ appsNo: '1', smId: 'c2cm21350' }),
      /sales_record_sm_id_uppercase/,
    );
  });

  it('rejects an OTHERS correction with no description', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    await expectDbError(
      db.insert(correctionRequest).values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'OTHERS',
        fieldName: 'pay_mode',
        fieldLabel: 'Pay Mode',
        proposedValue: 'UPI',
        description: '   ',
        submittedBy: actor.id,
        smId: 'ICCSP90766',
      }),
      /correction_others_requires_description/,
    );
  });

  it('allows an AUTOPAY correction with no description', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    const [row] = await db
      .insert(correctionRequest)
      .values(openRequestFor(record.id, record.appsNo, actor.id))
      .returning();
    expect(row.status).toBe('PENDING');
  });

  it('prevents two open corrections on the same record and field', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    const base = openRequestFor(record.id, record.appsNo, actor.id);
    await db.insert(correctionRequest).values(base);
    await expectDbError(db.insert(correctionRequest).values(base), /correction_one_open_per_field/);
  });

  it('allows a new request once the previous one is resolved', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    const base = openRequestFor(record.id, record.appsNo, actor.id);
    const [first] = await db.insert(correctionRequest).values(base).returning();
    await db
      .update(correctionRequest)
      .set({ status: 'REJECTED' })
      .where(eq(correctionRequest.id, first.id));
    const [second] = await db.insert(correctionRequest).values(base).returning();
    expect(second.id).not.toBe(first.id);
  });

  it('refuses to update an audit_log row', async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        action: 'AUTH_LOGIN',
        entityType: 'user',
        entityId: 'abc',
        actorEmail: 'a@example.test',
        actorRole: 'admin',
      })
      .returning();
    await expectDbError(
      db.update(auditLog).set({ action: 'TAMPERED' }).where(eq(auditLog.id, row.id)),
      /append-only/,
    );
  });

  it('refuses to delete an audit_log row', async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        action: 'AUTH_LOGIN',
        entityType: 'user',
        entityId: 'abc',
        actorEmail: 'a@example.test',
        actorRole: 'admin',
      })
      .returning();
    await expectDbError(db.delete(auditLog).where(eq(auditLog.id, row.id)), /append-only/);
  });
});
