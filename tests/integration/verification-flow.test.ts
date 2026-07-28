import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditLog,
  correctionEvent,
  correctionRequest,
  notification,
  salesRecord,
  salesRecordVersion,
  user,
} from '@/db/schema';
import { applyApproval, returnRequest } from '@/lib/approvals/apply';
import { returnFromVerification, verifyRequest } from '@/lib/verification/apply';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

/**
 * The two-stage flow end to end — 2026-07-28 spec section 3.
 *
 * `tests/integration/approvals-apply.test.ts` proves the gate REFUSES an
 * unverified request. This file proves the other half: that the verification
 * stage itself does what it claims, that a request can travel the whole path,
 * and that the two stages stay attributable to different people afterwards.
 */

const OWNER = 'ICCSP90766';

async function seed() {
  const rep = await makeUser({ role: 'sales', smId: OWNER, name: 'Priya Sales' });
  const verifierRow = await makeUser({ role: 'verifier', smId: null, name: 'Vidya Verifier' });
  const approverRow = await makeUser({ role: 'approver', smId: null, name: 'Anand Approver' });

  const verifier = { id: verifierRow.id, email: verifierRow.email, role: 'verifier' as const };
  const approver = { id: approverRow.id, email: approverRow.email, role: 'approver' as const };

  const [record] = await db
    .insert(salesRecord)
    .values({ appsNo: '6167509575', smId: OWNER, clientName: 'Meera Nair', status: 'ISSUED' })
    .returning();

  await db.insert(salesRecordVersion).values({
    recordId: record.id,
    version: 1,
    data: record as unknown as Record<string, unknown>,
    changeType: 'IMPORT',
  });

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
      smId: OWNER,
      status: 'PENDING',
    })
    .returning();

  await db.insert(correctionEvent).values({
    requestId: request.id,
    action: 'SUBMITTED',
    actorId: rep.id,
    toStatus: 'PENDING',
  });

  return { rep, verifier, approver, record, request };
}

const reloadRequest = async (id: string) =>
  (await db.select().from(correctionRequest).where(eq(correctionRequest.id, id)))[0];

const reloadRecord = async (id: string) =>
  (await db.select().from(salesRecord).where(eq(salesRecord.id, id)))[0];

describe('verifying a request (2026-07-28 spec 3)', () => {
  beforeEach(truncateAll);

  it('moves PENDING to VERIFIED without touching the record', async () => {
    const { verifier, record, request } = await seed();

    const outcome = await verifyRequest({
      requestId: request.id,
      actor: verifier,
      remarks: 'Mandate copy matches the application.',
    });

    expect(outcome.status).toBe('VERIFIED');

    const verified = await reloadRequest(request.id);
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verifiedBy).toBe(verifier.id);
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.verifierRemarks).toBe('Mandate copy matches the application.');

    // Verification is an assertion that the claim and its proof hang together,
    // NOT an application of the change. If it wrote the value, the approver
    // would be deciding whether to keep a change that had already landed —
    // a different and much weaker question than the one they are there for.
    const untouched = await reloadRecord(record.id);
    expect(untouched.autopay).toBeNull();
    expect(untouched.currentVersion).toBe(1);
    expect(untouched.hasCorrections).toBe(false);
    expect(
      await db.select().from(salesRecordVersion).where(eq(salesRecordVersion.recordId, record.id)),
    ).toHaveLength(1);

    // The approver columns stay empty: nobody has decided anything yet, and
    // filling them would put the verifier's name in the "who approved" field
    // that the export's decision column reads.
    expect(verified.reviewedBy).toBeNull();
    expect(verified.approverRemarks).toBeNull();
  });

  it('notifies the approvers and tells the rep their claim moved on', async () => {
    const { rep, verifier, approver, request } = await seed();

    const outcome = await verifyRequest({ requestId: request.id, actor: verifier });
    expect(outcome.notified).toBe(1);

    const toApprover = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, approver.id));
    expect(toApprover).toHaveLength(1);
    expect(toApprover[0].type).toBe('CORRECTION_VERIFIED');
    expect(toApprover[0].link).toBe(`/approver/requests/${request.id}`);

    // The rep hears too. Without it, the only observable difference between
    // "waiting on a verifier" and "waiting on an approver" is a status word they
    // would have to go looking for.
    const toRep = await db.select().from(notification).where(eq(notification.userId, rep.id));
    expect(toRep).toHaveLength(1);
    expect(toRep[0].type).toBe('CORRECTION_VERIFIED');
  });

  it('reports zero when no approver account exists', async () => {
    const { verifier, approver, request } = await seed();

    // Deactivating, not deleting — users are never hard-deleted (base spec 4.2),
    // and `notifyActiveApprovers` filters on isActive precisely so a disabled
    // account's unread count does not grow behind a login nobody can use.
    await db.update(user).set({ isActive: false }).where(eq(user.id, approver.id));

    const outcome = await verifyRequest({ requestId: request.id, actor: verifier });

    // The verification still stands — refusing would strand the request with
    // nobody able to move it. But the count is surfaced so the verifier, the
    // last person in a position to notice, is told.
    expect(outcome.status).toBe('VERIFIED');
    expect(outcome.notified).toBe(0);
    expect((await reloadRequest(request.id)).status).toBe('VERIFIED');
  });

  it('writes its own audit row naming the verification stage', async () => {
    const { verifier, request } = await seed();

    await verifyRequest({ requestId: request.id, actor: verifier, remarks: 'Checked.' });

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'CORRECTION_VERIFY'));
    expect(rows).toHaveLength(1);
    expect(rows[0].entityId).toBe(request.id);
    expect((rows[0].before as Record<string, unknown>).status).toBe('PENDING');
    expect((rows[0].after as Record<string, unknown>).status).toBe('VERIFIED');
  });

  it('lets exactly one of two simultaneous verifications through', async () => {
    const { request } = await seed();
    const a = await makeUser({ role: 'verifier', smId: null });
    const b = await makeUser({ role: 'verifier', smId: null });

    const results = await Promise.allSettled([
      verifyRequest({ requestId: request.id, actor: { id: a.id, email: a.email, role: 'verifier' } }),
      verifyRequest({ requestId: request.id, actor: { id: b.id, email: b.email, role: 'verifier' } }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected');
    expect(loser && (loser as PromiseRejectedResult).reason).toMatchObject({
      code: 'NOT_PENDING',
    });

    // The loser wrote nothing: one VERIFIED event, not two, and the approvers
    // were told about this claim once rather than twice.
    const events = await db
      .select()
      .from(correctionEvent)
      .where(and(eq(correctionEvent.requestId, request.id), eq(correctionEvent.action, 'VERIFIED')));
    expect(events).toHaveLength(1);
  });
});

describe('returning from verification (2026-07-28 spec 3.1)', () => {
  beforeEach(truncateAll);

  it('sends the request back to the rep, not onward to an approver', async () => {
    const { rep, verifier, approver, request } = await seed();

    const outcome = await returnFromVerification({
      requestId: request.id,
      actor: verifier,
      remarks: 'The screenshot is unreadable — attach the mandate PDF.',
    });

    expect(outcome.status).toBe('RETURNED');

    const returned = await reloadRequest(request.id);
    expect(returned.status).toBe('RETURNED');
    // verifiedBy records who LOOKED, not who approved — the status says the
    // outcome was a return, and the verifier's own history counts from here.
    expect(returned.verifiedBy).toBe(verifier.id);
    expect(returned.verifierRemarks).toContain('unreadable');
    expect(returned.reviewedBy).toBeNull();

    const toRep = await db.select().from(notification).where(eq(notification.userId, rep.id));
    expect(toRep).toHaveLength(1);
    // Distinct from CORRECTION_RETURNED so the rep's inbox says which stage sent
    // it back — the fix differs depending on which.
    expect(toRep[0].type).toBe('CORRECTION_RETURNED_BY_VERIFIER');

    expect(
      await db.select().from(notification).where(eq(notification.userId, approver.id)),
    ).toHaveLength(0);
  });

  it('refuses a return with no remarks', async () => {
    const { verifier, request } = await seed();

    await expect(
      returnFromVerification({ requestId: request.id, actor: verifier, remarks: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });

    expect((await reloadRequest(request.id)).status).toBe('PENDING');
  });

  it('records the return under its own audit action', async () => {
    const { verifier, request } = await seed();

    await returnFromVerification({ requestId: request.id, actor: verifier, remarks: 'No proof.' });

    // Both stages write a RETURNED event, so the status column cannot tell them
    // apart afterwards. The distinct audit action is what lets anyone ask how
    // much the verification stage is sending back — the number that says whether
    // the gate is doing work or waving things through.
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_RETURN_VERIFIER')),
    ).toHaveLength(1);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_RETURN')),
    ).toHaveLength(0);
  });

  it('cannot verify a request that is already returned', async () => {
    const { verifier, request } = await seed();

    await returnFromVerification({ requestId: request.id, actor: verifier, remarks: 'No proof.' });

    await expect(
      verifyRequest({ requestId: request.id, actor: verifier }),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
  });
});

describe('the full path, submit to applied (2026-07-28 spec 3.1)', () => {
  beforeEach(truncateAll);

  it('applies the change once and keeps both reviewers on the row', async () => {
    const { verifier, approver, record, request } = await seed();

    await verifyRequest({ requestId: request.id, actor: verifier, remarks: 'Proof checked.' });
    const outcome = await applyApproval({
      requestId: request.id,
      actor: approver,
      remarks: 'Applied.',
    });

    expect(outcome.newValue).toBe('Yes');

    const after = await reloadRecord(record.id);
    expect(after.autopay).toBe('Yes');
    // Once, not twice: verification must not have written a version of its own.
    expect(after.currentVersion).toBe(2);
    expect(
      await db.select().from(salesRecordVersion).where(eq(salesRecordVersion.recordId, record.id)),
    ).toHaveLength(2);

    const final = await reloadRequest(request.id);
    expect(final.status).toBe('APPROVED');
    expect(final.verifiedBy).toBe(verifier.id);
    expect(final.reviewedBy).toBe(approver.id);
    // The whole point of two stages: two different people, both named. An audit
    // that can only name one cannot say whether a bad value got through because
    // the verifier missed it or because the approver overrode them.
    expect(final.verifiedBy).not.toBe(final.reviewedBy);
    expect(final.verifierRemarks).toBe('Proof checked.');
    expect(final.approverRemarks).toBe('Applied.');

    const timeline = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, request.id))
      .orderBy(correctionEvent.createdAt);
    expect(timeline.map((e) => e.action)).toEqual(['SUBMITTED', 'VERIFIED', 'APPROVED']);
  });

  it('keeps the field locked while the request sits verified', async () => {
    const { rep, verifier, record, request } = await seed();

    await verifyRequest({ requestId: request.id, actor: verifier });

    // The window between "a verifier passed it" and "an approver decided it" is
    // the one the widened partial index exists to cover. Without VERIFIED in the
    // predicate the field would look free here, a second claim could open, and
    // two approvals would race for the same column.
    // expectDbError, not rejects.toThrow: Drizzle wraps driver errors, so the
    // constraint name that actually identifies the violation sits on the cause
    // chain. Matching the top-level message would pass for any failure at all.
    await expectDbError(
      db.insert(correctionRequest).values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'No',
        submittedBy: rep.id,
        smId: OWNER,
        status: 'PENDING',
      }),
      /correction_one_open_per_field/,
    );

    expect((await reloadRequest(request.id)).status).toBe('VERIFIED');
  });

  it('sends an approver return back to the rep, not to the verifier', async () => {
    const { rep, verifier, approver, request } = await seed();

    await verifyRequest({ requestId: request.id, actor: verifier });
    await returnRequest({
      requestId: request.id,
      actor: approver,
      remarks: 'The date on the mandate is wrong.',
    });

    const returned = await reloadRequest(request.id);
    expect(returned.status).toBe('RETURNED');
    // One RETURNED status serves both stages so the rep learns one return path,
    // and one resubmission button serves both. Which stage sent it back is
    // answered by the actor's role on the event row.
    expect(returned.reviewedBy).toBe(approver.id);
    expect(returned.verifiedBy).toBe(verifier.id);

    const toRep = await db
      .select()
      .from(notification)
      .where(and(eq(notification.userId, rep.id), eq(notification.type, 'CORRECTION_RETURNED')));
    expect(toRep).toHaveLength(1);
  });
});
