import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditLog,
  correctionEvent,
  correctionRequest,
  manpower,
  notification,
  salesRecord,
  salesRecordVersion,
} from '@/db/schema';
import {
  ApprovalError,
  applyApproval,
  applyApprovalWithin,
  rejectRequest,
  returnRequest,
} from '@/lib/approvals/apply';
import { verifyRequest } from '@/lib/verification/apply';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The approval transaction — spec section 7.3.
 *
 * These run against a real database because every invariant under test is a
 * database invariant: row locking, atomic rollback, and the unique
 * (record_id, version) index. A mocked db would assert that the code calls the
 * functions it calls, which is not the same claim at all.
 */

const OWNER = 'ICCSP90766';
const CLAIMANT = 'C2CM21350';

type Actor = { id: string; email: string; role: 'approver' };
type VerifierActor = { id: string; email: string; role: 'verifier' };

async function makeApprover(): Promise<Actor> {
  const row = await makeUser({ role: 'approver', smId: null });
  return { id: row.id, email: row.email, role: 'approver' };
}

async function makeVerifier(): Promise<VerifierActor> {
  const row = await makeUser({ role: 'verifier', smId: null });
  return { id: row.id, email: row.email, role: 'verifier' };
}

/**
 * Creates a record the way a committed import leaves it: the row plus its v1
 * snapshot. The v1 row is not decoration — the convention under test is that
 * version N holds the state AT version N, so an approval that wrote the
 * pre-change state would duplicate this row rather than extend the chain.
 */
async function makeRecord(overrides: Partial<typeof salesRecord.$inferInsert> = {}) {
  const [row] = await db
    .insert(salesRecord)
    .values({
      appsNo: '6167509575',
      smId: OWNER,
      smName: 'Original Owner',
      clientName: 'A Client',
      status: 'ISSUED',
      autopay: null,
      ...overrides,
    })
    .returning();

  await db.insert(salesRecordVersion).values({
    recordId: row.id,
    version: row.currentVersion,
    data: row as unknown as Record<string, unknown>,
    changeType: 'IMPORT',
  });

  return row;
}

/**
 * A request in the state an APPROVER receives it: already verified.
 *
 * Since the 2026-07-28 gate, PENDING means "awaiting a verifier" and the
 * approval transaction refuses it outright. Seeding these tests as PENDING
 * would test nothing but the gate, over and over, while the transaction they
 * exist to cover never ran. The default therefore walks the request through
 * verification first — status, columns and timeline event, exactly as
 * `verifyRequest` leaves it.
 *
 * Pass `status: 'PENDING'` (and no verifier) to construct the unverified case
 * deliberately; the gate itself is asserted in `the verifier gate` below.
 */
async function makeRequest(
  recordId: string,
  appsNo: string,
  submittedBy: string,
  overrides: Partial<typeof correctionRequest.$inferInsert> = {},
) {
  const verifier = overrides.verifiedBy === undefined ? await makeVerifier() : null;

  const [row] = await db
    .insert(correctionRequest)
    .values({
      recordId,
      appsNo,
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      originalValue: null,
      proposedValue: 'Yes',
      submittedBy,
      smId: OWNER,
      status: 'VERIFIED',
      verifiedBy: verifier?.id,
      verifiedAt: new Date(),
      ...overrides,
      // Derived from the category rather than defaulted alongside it: the CHECK
      // `correction_direction_iff_mapping` requires a direction on exactly the
      // MAPPING rows, so an override that switches the category has to carry the
      // direction with it. Every fixture here is a claim — the pull direction.
      direction:
        overrides.direction ?? ((overrides.category ?? 'AUTOPAY') === 'MAPPING' ? 'CLAIM_IN' : null),
    })
    .returning();

  await db.insert(correctionEvent).values({
    requestId: row.id,
    action: 'SUBMITTED',
    actorId: submittedBy,
    toStatus: 'PENDING',
  });

  if (row.status === 'VERIFIED') {
    await db.insert(correctionEvent).values({
      requestId: row.id,
      action: 'VERIFIED',
      actorId: row.verifiedBy,
      fromStatus: 'PENDING',
      toStatus: 'VERIFIED',
    });
  }

  return row;
}

/** Ordered ascending so `versions[n - 1]` is version n. */
async function versionsFor(recordId: string) {
  return db
    .select()
    .from(salesRecordVersion)
    .where(eq(salesRecordVersion.recordId, recordId))
    .orderBy(salesRecordVersion.version);
}

async function reload(recordId: string) {
  const [row] = await db.select().from(salesRecord).where(eq(salesRecord.id, recordId));
  return row;
}

async function reloadRequest(requestId: string) {
  const [row] = await db.select().from(correctionRequest).where(eq(correctionRequest.id, requestId));
  return row;
}

describe('applying an approval (spec 7.3)', () => {
  beforeEach(truncateAll);

  it('applies the value, extends the version chain, and flags the record', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    const outcome = await applyApproval({
      requestId: request.id,
      actor: approver,
      remarks: 'Bank mandate seen.',
    });

    const after = await reload(record.id);
    expect(after.autopay).toBe('Yes');
    expect(after.hasCorrections).toBe(true);
    expect(after.currentVersion).toBe(2);

    // Version N holds the state AT version N: v1 is the untouched imported row
    // and v2 carries the approved value. The pre-change state is preserved as
    // v1 rather than copied into v2, and `current_version` names a row that
    // actually exists.
    const versions = await versionsFor(record.id);
    expect(versions).toHaveLength(2);

    expect(versions[0].version).toBe(1);
    expect(versions[0].changeType).toBe('IMPORT');
    expect((versions[0].data as Record<string, unknown>).autopay).toBeNull();

    expect(versions[1].version).toBe(2);
    expect(versions[1].changeType).toBe('CORRECTION');
    expect((versions[1].data as Record<string, unknown>).autopay).toBe('Yes');
    expect((versions[1].data as Record<string, unknown>).currentVersion).toBe(2);
    expect(versions[1].changedFields).toEqual(['autopay']);
    expect(versions[1].correctionRequestId).toBe(request.id);
    expect(versions[1].version).toBe(outcome.appliedVersion);
    expect(outcome.appliedVersion).toBe(2);

    const decided = await reloadRequest(request.id);
    expect(decided.status).toBe('APPROVED');
    expect(decided.reviewedBy).toBe(approver.id);
    expect(decided.reviewedAt).not.toBeNull();
    expect(decided.appliedAt).not.toBeNull();
    expect(decided.appliedVersion).toBe(2);
    expect(decided.approverRemarks).toBe('Bank mandate seen.');

    const events = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, request.id));
    // Three now, not two: the request passed a verifier on its way here, and
    // that stage leaves its own event so the timeline shows both reviews.
    expect(events.map((e) => e.action).sort()).toEqual(['APPROVED', 'SUBMITTED', 'VERIFIED']);

    const audits = await db.select().from(auditLog);
    expect(audits.map((a) => a.action).sort()).toEqual(['CORRECTION_APPROVE', 'RECORD_UPDATE']);

    const notes = await db.select().from(notification).where(eq(notification.userId, rep.id));
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe('CORRECTION_APPROVED');
  });

  it('normalizes the approved value instead of writing the submitted text verbatim', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord({ appsNo: '6167509576' });
    const request = await makeRequest(record.id, record.appsNo, rep.id, { proposedValue: 'y' });

    await applyApproval({ requestId: request.id, actor: approver });

    expect((await reload(record.id)).autopay).toBe('Yes');
  });

  it('refuses a proposed value the field cannot hold', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord({ appsNo: '6167509577' });
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      category: 'ISSUANCE_DATE',
      fieldName: 'issuedDate',
      fieldLabel: 'Issued date',
      proposedValue: 'sometime in June',
    });

    await expect(applyApproval({ requestId: request.id, actor: approver })).rejects.toMatchObject({
      code: 'INVALID_VALUE',
    });

    // Only the import's own v1 — the approval added nothing.
    expect(await versionsFor(record.id)).toHaveLength(1);
    // Still VERIFIED and still decidable: a rejected coercion is not a decision,
    // so the request must stay in the approver's queue for them to return it.
    expect((await reloadRequest(request.id)).status).toBe('VERIFIED');
  });
});

describe('the concurrent-approval race (spec 7.3, step 1)', () => {
  beforeEach(truncateAll);

  it('lets exactly one of two simultaneous approvals through', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const first = await makeApprover();
    const second = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    // Two approvers, one request, fired together. Without the FOR UPDATE re-read
    // both would snapshot the same pre-change state, both would write a version,
    // and one update would be lost with no trace that it ever happened.
    const settled = await Promise.allSettled([
      applyApproval({ requestId: request.id, actor: first, remarks: 'first' }),
      applyApproval({ requestId: request.id, actor: second, remarks: 'second' }),
    ]);

    const winners = settled.filter((r) => r.status === 'fulfilled');
    const losers = settled.filter((r) => r.status === 'rejected');

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const loser = losers[0] as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ApprovalError);
    expect((loser.reason as ApprovalError).code).toBe('NOT_PENDING');

    // Two rows total: the import's v1 and exactly one CORRECTION from the
    // winner. A second version here would be the lost update this lock exists
    // to prevent.
    const versions = await versionsFor(record.id);
    expect(versions).toHaveLength(2);
    expect(versions.filter((v) => v.changeType === 'CORRECTION')).toHaveLength(1);

    const after = await reload(record.id);
    expect(after.currentVersion).toBe(record.currentVersion + 1);
    expect(after.autopay).toBe('Yes');
    expect((versions[1].data as Record<string, unknown>).autopay).toBe('Yes');

    const decided = await reloadRequest(request.id);
    expect(decided.status).toBe('APPROVED');
    expect(decided.appliedVersion).toBe(2);

    // The loser wrote nothing at all — not an event, not an audit row.
    const approvedEvents = await db
      .select()
      .from(correctionEvent)
      .where(and(eq(correctionEvent.requestId, request.id), eq(correctionEvent.action, 'APPROVED')));
    expect(approvedEvents).toHaveLength(1);

    const approveAudits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'CORRECTION_APPROVE'));
    expect(approveAudits).toHaveLength(1);

    const notes = await db.select().from(notification);
    expect(notes).toHaveLength(1);
  });
});

describe('rollback (spec 7.3, "any failure rolls the whole thing back")', () => {
  beforeEach(truncateAll);

  it('leaves no version, no audit row and no notification when the last step fails', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    await expect(
      db.transaction(async (tx) => {
        await applyApprovalWithin(tx, { requestId: request.id, actor: approver });
        // Everything the approval writes is already on this transaction; the
        // throw stands in for any failure after the notification insert.
        throw new Error('forced failure after the last step');
      }),
    ).rejects.toThrow('forced failure after the last step');

    const survivors = await versionsFor(record.id);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].changeType).toBe('IMPORT');
    expect(await db.select().from(auditLog)).toHaveLength(0);
    expect(await db.select().from(notification)).toHaveLength(0);

    const untouched = await reload(record.id);
    expect(untouched.autopay).toBeNull();
    expect(untouched.currentVersion).toBe(1);
    expect(untouched.hasCorrections).toBe(false);

    // Rolled back to the state the approver found it in — verified and waiting,
    // not all the way back to unverified. The verification was a separate,
    // already-committed transaction and this failure has nothing to do with it.
    const stillOpen = await reloadRequest(request.id);
    expect(stillOpen.status).toBe('VERIFIED');
    expect(stillOpen.verifiedBy).not.toBeNull();
    expect(stillOpen.reviewedBy).toBeNull();
    expect(stillOpen.appliedVersion).toBeNull();

    const events = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, request.id));
    expect(events.map((e) => e.action)).toEqual(['SUBMITTED', 'VERIFIED']);
  });
});

describe('terminal states (spec 7)', () => {
  beforeEach(truncateAll);

  it('refuses to approve a request that was already rejected', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    await rejectRequest({ requestId: request.id, actor: approver, remarks: 'No proof attached.' });

    await expect(applyApproval({ requestId: request.id, actor: approver })).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });

    expect(await versionsFor(record.id)).toHaveLength(1);
    expect((await reload(record.id)).autopay).toBeNull();
  });

  it('refuses to reject a request that was already approved', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    await applyApproval({ requestId: request.id, actor: approver });

    await expect(
      rejectRequest({ requestId: request.id, actor: approver, remarks: 'changed my mind' }),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });

    expect((await reloadRequest(request.id)).status).toBe('APPROVED');
  });

  it('requires remarks on a rejection', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    await expect(
      rejectRequest({ requestId: request.id, actor: approver, remarks: '   ' }),
    ).rejects.toMatchObject({ code: 'INVALID_VALUE' });

    expect((await reloadRequest(request.id)).status).toBe('VERIFIED');
  });
});

/**
 * The gate itself — 2026-07-28 spec section 3.4.
 *
 * These are the tests that fail loudly if a later refactor drops the VERIFIED
 * predicate and quietly reopens the direct path from submission to approval.
 * Nothing on any screen would look different if that happened.
 */
describe('the verifier gate (2026-07-28 spec 3.4)', () => {
  beforeEach(truncateAll);

  async function unverified() {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      status: 'PENDING',
      verifiedBy: null,
      verifiedAt: null,
    });
    return { rep, approver, record, request };
  }

  it('refuses to approve a request no verifier has passed', async () => {
    const { approver, record, request } = await unverified();

    await expect(applyApproval({ requestId: request.id, actor: approver })).rejects.toMatchObject({
      code: 'NOT_PENDING',
    });

    // The record is the thing that must not have moved. A gate that threw after
    // writing would be worse than no gate: the change would be applied and the
    // request would still read as awaiting verification.
    const after = await reload(record.id);
    expect(after.autopay).toBeNull();
    expect(after.currentVersion).toBe(1);
    expect(await versionsFor(record.id)).toHaveLength(1);
    expect((await reloadRequest(request.id)).status).toBe('PENDING');
  });

  it('refuses to reject or return a request no verifier has passed', async () => {
    const { approver, request } = await unverified();

    await expect(
      rejectRequest({ requestId: request.id, actor: approver, remarks: 'No.' }),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });

    await expect(
      returnRequest({ requestId: request.id, actor: approver, remarks: 'More proof.' }),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });

    expect((await reloadRequest(request.id)).status).toBe('PENDING');
  });

  it('says the request is unverified rather than that it was already decided', async () => {
    const { approver, request } = await unverified();

    // The distinction is the whole value of the message: "already decided" sends
    // an approver looking for a decision nobody made, when what they must do is
    // wait for a verifier.
    await expect(applyApproval({ requestId: request.id, actor: approver })).rejects.toThrow(
      /not been verified/i,
    );
  });

  it('approves the same request once a verifier has passed it', async () => {
    const { approver, record, request } = await unverified();
    const verifier = await makeVerifier();

    await db
      .update(correctionRequest)
      .set({ status: 'VERIFIED', verifiedBy: verifier.id, verifiedAt: new Date() })
      .where(eq(correctionRequest.id, request.id));

    const outcome = await applyApproval({ requestId: request.id, actor: approver });

    expect(outcome.newValue).toBe('Yes');
    expect((await reload(record.id)).autopay).toBe('Yes');

    // Both gates are named on the row afterwards, by different people. This is
    // what the export and the audit read to say who is accountable for a value.
    const applied = await reloadRequest(request.id);
    expect(applied.verifiedBy).toBe(verifier.id);
    expect(applied.reviewedBy).toBe(approver.id);
    expect(applied.verifiedBy).not.toBe(applied.reviewedBy);
  });
});

describe('return, resubmit, approve (spec 7)', () => {
  beforeEach(truncateAll);

  it('keeps one request row and a complete timeline across the round trip', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const approver = await makeApprover();
    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    await returnRequest({
      requestId: request.id,
      actor: approver,
      remarks: 'The screenshot is unreadable — attach the mandate PDF.',
    });

    const returned = await reloadRequest(request.id);
    expect(returned.status).toBe('RETURNED');
    expect(returned.approverRemarks).toContain('unreadable');

    const returnNotes = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, rep.id));
    expect(returnNotes.map((n) => n.type)).toEqual(['CORRECTION_RETURNED']);

    // Stands in for the sales-side resubmit action, which owns this transition.
    // It goes back to PENDING, not to VERIFIED: a resubmission re-enters the
    // flow at the top, or a rep could bypass the gate by getting returned once
    // on purpose.
    await db
      .update(correctionRequest)
      .set({
        status: 'PENDING',
        resubmissionCount: 1,
        lastResubmittedAt: new Date(),
        proposedValue: 'Yes',
        verifiedBy: null,
        verifiedAt: null,
        verifierRemarks: null,
      })
      .where(eq(correctionRequest.id, request.id));
    await db.insert(correctionEvent).values({
      requestId: request.id,
      action: 'RESUBMITTED',
      actorId: rep.id,
      fromStatus: 'RETURNED',
      toStatus: 'PENDING',
      remarks: 'Mandate PDF attached.',
    });

    // And it must be verified AGAIN before the approver can act. Asserting the
    // refusal here is what proves the second lap is not skipped.
    await expect(
      applyApproval({ requestId: request.id, actor: approver, remarks: 'Now legible.' }),
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });

    const verifier = await makeVerifier();
    await verifyRequest({ requestId: request.id, actor: verifier, remarks: 'PDF is legible.' });

    await applyApproval({ requestId: request.id, actor: approver, remarks: 'Now legible.' });

    const all = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.recordId, record.id));
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('APPROVED');
    expect(all[0].resubmissionCount).toBe(1);

    const timeline = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, request.id))
      .orderBy(correctionEvent.createdAt);
    // The whole conversation on one row: verified, returned by the approver,
    // resubmitted, verified AGAIN, then approved. Both laps through the gate are
    // visible, which is the point of keeping one request rather than forking a
    // second one that has lost the history.
    expect(timeline.map((e) => e.action)).toEqual([
      'SUBMITTED',
      'VERIFIED',
      'RETURNED',
      'RESUBMITTED',
      'VERIFIED',
      'APPROVED',
    ]);

    expect((await reload(record.id)).autopay).toBe('Yes');
  });
});

describe('mapping claims (spec 7.2)', () => {
  beforeEach(truncateAll);

  async function mappingSetup(opts: { roster: boolean }) {
    const losing = await makeUser({ role: 'sales', smId: OWNER, name: 'Losing Rep' });
    const gaining = await makeUser({ role: 'sales', smId: CLAIMANT, name: 'Gaining Rep' });
    const approver = await makeApprover();

    if (opts.roster) {
      await db.insert(manpower).values({ smId: CLAIMANT, smName: 'Ravi Kumar', location: 'Pune' });
    }

    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, gaining.id, {
      category: 'MAPPING',
      fieldName: 'smId',
      fieldLabel: 'SM ID',
      originalValue: OWNER,
      // Deliberately lowercase: the DB CHECK rejects a lowercase sm_id, so an
      // approval that skipped normalization would abort here.
      proposedValue: CLAIMANT.toLowerCase(),
      smId: CLAIMANT,
    });

    return { losing, gaining, approver, record, request };
  }

  it('moves the record, resolves sm_name from the roster, and notifies both reps', async () => {
    const { losing, gaining, approver, record, request } = await mappingSetup({ roster: true });

    const outcome = await applyApproval({ requestId: request.id, actor: approver });
    expect(outcome.warnings).toEqual([]);

    const after = await reload(record.id);
    expect(after.smId).toBe(CLAIMANT);
    expect(after.smName).toBe('Ravi Kumar');
    expect(after.hasCorrections).toBe(true);

    const versions = await versionsFor(record.id);
    expect(versions).toHaveLength(2);
    // v1 still holds the losing rep, which is how a disputed sale stays
    // traceable (spec 7.2); v2 holds the reassignment that was approved.
    expect((versions[0].data as Record<string, unknown>).smId).toBe(OWNER);
    expect((versions[0].data as Record<string, unknown>).smName).toBe('Original Owner');
    expect(versions[1].changedFields).toEqual(['smId', 'smName']);
    expect((versions[1].data as Record<string, unknown>).smId).toBe(CLAIMANT);
    expect((versions[1].data as Record<string, unknown>).smName).toBe('Ravi Kumar');

    const lost = await db.select().from(notification).where(eq(notification.userId, losing.id));
    expect(lost).toHaveLength(1);
    expect(lost[0].type).toBe('MAPPING_LOST');

    const gained = await db.select().from(notification).where(eq(notification.userId, gaining.id));
    expect(gained).toHaveLength(1);
    expect(gained[0].type).toBe('MAPPING_GAINED');

    expect((await reloadRequest(request.id)).status).toBe('APPROVED');
  });

  it('clears the name and warns when the roster has no entry for the claimant', async () => {
    const { approver, record, request } = await mappingSetup({ roster: false });

    const outcome = await applyApproval({ requestId: request.id, actor: approver });

    const after = await reload(record.id);
    expect(after.smId).toBe(CLAIMANT);
    // Keeping "Original Owner" here would leave sm_id and sm_name pointing at
    // two different people, which spec 7.2 forbids outright.
    expect(after.smName).toBeNull();
    expect(outcome.warnings.join(' ')).toMatch(/roster/i);
  });
});
