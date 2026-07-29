import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditLog,
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  notification,
  salesRecord,
} from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import {
  resubmitCorrection,
  submitCorrection,
  withdrawCorrection,
} from '@/lib/corrections/service';
import { deleteStoredProofs } from '@/lib/storage/files';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * Submission, resubmission and withdrawal against the real database — spec
 * section 7.
 *
 * These go through the service rather than the Server Action wrappers because
 * the wrappers do exactly two things the service does not: call `requireRole`
 * and decode a FormData. What is under test here is the workflow and the
 * invariants the database enforces, and both are in the service.
 */

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const proof = (name = 'proof.png') => ({ name, bytes: PNG });

const OWNER_SM_ID = 'ICCSP90766';
const OTHER_SM_ID = 'C2CM21350';

function sessionFor(row: { id: string; name: string; email: string; role: string; smId: string | null }): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

async function makeRecord(overrides: Partial<typeof salesRecord.$inferInsert> = {}) {
  const [row] = await db
    .insert(salesRecord)
    .values({
      appsNo: '6167509575',
      smId: OWNER_SM_ID,
      smName: 'Owner Rep',
      clientName: 'Ravi Kumar',
      productName: 'Assured Wealth Goal',
      status: 'ISSUED',
      issuedDate: '2026-06-03',
      autopay: null,
      ...overrides,
    })
    .returning();
  return row;
}

/** Removes the proof files these tests write, so the storage dir does not grow. */
async function clearStoredProofs() {
  const rows = await db.select({ path: correctionAttachment.storedPath }).from(correctionAttachment);
  await deleteStoredProofs(rows.map((r) => r.path));
}

describe('submitting a correction (spec 7)', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  it('creates a PENDING request, a SUBMITTED event, an audit row and verifier notifications', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    await makeUser({ role: 'verifier', smId: null });
    await makeUser({ role: 'verifier', smId: null });
    // An approver exists and must NOT be notified: since the 2026-07-28 gate a
    // PENDING request is not actionable by them, so a notification would link to
    // a screen whose only button refuses.
    await makeUser({ role: 'approver', smId: null });
    const record = await makeRecord();

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));

    expect(row.status).toBe('PENDING');
    expect(row.category).toBe('AUTOPAY');
    expect(row.fieldName).toBe('autopay');
    expect(row.fieldLabel).toBe('AutoPay');
    expect(row.proposedValue).toBe('Yes');
    // The pre-change value is snapshotted so it survives independently of the
    // record — one of the three places section 5.5 keeps it.
    expect(row.originalValue).toBeNull();
    expect(row.smId).toBe(OWNER_SM_ID);
    expect(row.resubmissionCount).toBe(0);

    const events = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, row.id));
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('SUBMITTED');
    expect(events[0].toStatus).toBe('PENDING');

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_SUBMIT'));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(row.id);

    // Every active VERIFIER hears about it — and only them. Two rows, not
    // three, is the assertion that the approver was left out.
    const notes = await db.select().from(notification);
    expect(notes).toHaveLength(2);
    expect(notes[0].type).toBe('CORRECTION_SUBMITTED');
    expect(notes.every((n) => n.link?.startsWith('/verifier/'))).toBe(true);
    expect(result.data.notified).toBe(2);
  });

  it('reports zero recipients when no verifier account exists', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    await makeUser({ role: 'approver', smId: null });
    const record = await makeRecord();

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The submit still succeeds — refusing would punish the rep for a
    // provisioning gap they cannot fix. But the count is surfaced and recorded,
    // because otherwise a request nobody can see is indistinguishable from one
    // being worked on.
    expect(result.data.notified).toBe(0);
    expect(await db.select().from(notification)).toHaveLength(0);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'CORRECTION_SUBMIT'));
    expect((audit.metadata as Record<string, unknown>).verifiersNotified).toBe(0);
  });

  it('stores the attachment with its hash and audits the upload', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof('bank-mandate.png'), proof('screenshot.png')],
    });
    expect(result.ok).toBe(true);

    const attachments = await db.select().from(correctionAttachment);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].mimeType).toBe('image/png');
    expect(attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachments[0].originalName).toBe('bank-mandate.png');
    // Outside public/, and named by a UUID rather than by anything uploaded.
    expect(attachments[0].storedPath).toMatch(/^proofs[\\/]\d{4}[\\/]\d{2}[\\/][0-9a-f-]{36}\.png$/);

    const uploads = await db.select().from(auditLog).where(eq(auditLog.action, 'ATTACHMENT_UPLOAD'));
    expect(uploads).toHaveLength(2);
  });

  it('refuses a submission with no proof', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one proof/i);
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('refuses a renamed file and writes nothing at all', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof(), { name: 'script.png', bytes: new Uint8Array(Buffer.from('<script>', 'utf8')) }],
    });

    expect(result.ok).toBe(false);
    // One bad file in the set means none of them are written — the valid one
    // must not be left behind as an orphan either.
    expect(await db.select().from(correctionAttachment)).toHaveLength(0);
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('rejects an OTHERS request with a blank description before the database has to', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();

    const result = await submitCorrection(rep, {
      category: 'OTHERS',
      appsNo: record.appsNo,
      fieldName: 'clientName',
      proposedValue: 'Ravi Kumaar',
      description: '   ',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.description?.[0]).toMatch(/description/i);
  });

  it('rejects a second open request for the same field of the same record', async () => {
    // The partial unique index of section 5.6 is the authority: two open claims
    // on one field would let two approvals produce a lost update.
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();

    const first = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    expect(first.ok).toBe(true);

    const second = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'No',
      files: [proof()],
    });

    expect(second.ok).toBe(false);
    // A clear answer, not a 500 leaking an index name.
    if (!second.ok) expect(second.error).toMatch(/already has an open correction/i);
    expect(await db.select().from(correctionRequest)).toHaveLength(1);
    expect(await db.select().from(correctionAttachment)).toHaveLength(1);
  });

  it('allows a second request for a DIFFERENT field of the same record', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord({ issuedDate: null });

    expect(
      (
        await submitCorrection(rep, {
          category: 'AUTOPAY',
          appsNo: record.appsNo,
          proposedValue: 'Yes',
          files: [proof()],
        })
      ).ok,
    ).toBe(true);

    expect(
      (
        await submitCorrection(rep, {
          category: 'ISSUANCE_DATE',
          appsNo: record.appsNo,
          proposedValue: '2026-06-03',
          files: [proof()],
        })
      ).ok,
    ).toBe(true);

    expect(await db.select().from(correctionRequest)).toHaveLength(2);
  });

  it('refuses a value the field already holds', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord({ autopay: 'Yes' });

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
  });
});

describe('scoping on submission (spec 4.1, 7.2)', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  it('refuses a non-mapping correction on another rep record', async () => {
    // The section 7.2 exception is for MAPPING alone. Knowing an application
    // number must not become a way to edit somebody else's book.
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OTHER_SM_ID }));
    const record = await makeRecord({ smId: OWNER_SM_ID });

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/in your book/i);
  });

  it('permits a MAPPING claim on another rep record', async () => {
    const claimant = sessionFor(await makeUser({ role: 'sales', smId: OTHER_SM_ID }));
    const record = await makeRecord({ smId: OWNER_SM_ID });

    const result = await submitCorrection(claimant, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: record.appsNo,
      proposedValue: OTHER_SM_ID,
      description: 'I sourced this policy.',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [row] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));
    expect(row.fieldName).toBe('smId');
    expect(row.originalValue).toBe(OWNER_SM_ID);
    expect(row.proposedValue).toBe(OTHER_SM_ID);
    // The claimant's SM_ID, not the record's — the request belongs to the rep
    // raising it.
    expect(row.smId).toBe(OTHER_SM_ID);
  });

  it('refuses a mapping claim that reassigns a sale to a third party', async () => {
    const claimant = sessionFor(await makeUser({ role: 'sales', smId: OTHER_SM_ID }));
    const record = await makeRecord({ smId: OWNER_SM_ID });

    const result = await submitCorrection(claimant, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: record.appsNo,
      proposedValue: 'C2CM99999',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/your own SM ID/i);
  });

  it('refuses a mapping claim on a record the claimant already owns', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord({ smId: OWNER_SM_ID });

    const result = await submitCorrection(rep, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: record.appsNo,
      proposedValue: OWNER_SM_ID,
      files: [proof()],
    });

    expect(result.ok).toBe(false);
  });

  it('refuses an actor who is not a scoped sales user', async () => {
    const admin = sessionFor(await makeUser({ role: 'admin', smId: null }));
    const record = await makeRecord();

    const result = await submitCorrection(admin, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
  });
});

describe('the resubmission cycle (spec 7)', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  async function submitThenReturn() {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const verifier = await makeUser({ role: 'verifier', smId: null });
    const record = await makeRecord();

    const submitted = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      description: 'Mandate is registered.',
      files: [proof()],
    });
    if (!submitted.ok) throw new Error(submitted.error);

    // Stands in for the reviewing side, which lives in another module. A
    // VERIFIER and not an approver: since the 2026-07-28 gate the only path out
    // of PENDING is the verifier's, and an approver acts on VERIFIED alone. A
    // fixture that stamped the approver columns here would build a row the
    // production code cannot produce, and would leave what a resubmission does
    // with the verification columns untested.
    await db
      .update(correctionRequest)
      .set({
        status: 'RETURNED',
        verifiedBy: verifier.id,
        verifiedAt: new Date(),
        verifierRemarks: 'The screenshot is unreadable.',
      })
      .where(eq(correctionRequest.id, submitted.data.id));

    await db.insert(correctionEvent).values({
      requestId: submitted.data.id,
      action: 'RETURNED',
      actorId: verifier.id,
      fromStatus: 'PENDING',
      toStatus: 'RETURNED',
      remarks: 'The screenshot is unreadable.',
    });

    return { rep, requestId: submitted.data.id };
  }

  it('reuses the same row and keeps the whole conversation on one timeline', async () => {
    const { rep, requestId } = await submitThenReturn();

    const result = await resubmitCorrection(rep, {
      requestId,
      proposedValue: 'Yes',
      description: 'Re-uploaded a clearer copy of the mandate.',
      files: [proof('clearer.png')],
    });

    expect(result.ok).toBe(true);

    // ONE row, not two: section 7 is explicit that resubmission reuses the
    // request so the history is not destroyed.
    const rows = await db.select().from(correctionRequest);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(requestId);
    expect(rows[0].status).toBe('PENDING');
    expect(rows[0].resubmissionCount).toBe(1);
    expect(rows[0].lastResubmittedAt).toBeInstanceOf(Date);
    // Cleared because the row's review columns describe the current review, and
    // there is not one yet. The remark itself survives on the RETURNED event.
    // All six go together — leaving the verification columns behind would show
    // the next verifier their predecessor's sign-off on a value that has since
    // changed.
    expect(rows[0].verifierRemarks).toBeNull();
    expect(rows[0].verifiedBy).toBeNull();
    expect(rows[0].verifiedAt).toBeNull();
    expect(rows[0].approverRemarks).toBeNull();
    expect(rows[0].reviewedBy).toBeNull();

    const events = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, requestId))
      .orderBy(correctionEvent.createdAt);

    expect(events.map((e) => e.action)).toEqual(['SUBMITTED', 'RETURNED', 'RESUBMITTED']);
    expect(events[1].remarks).toBe('The screenshot is unreadable.');

    const attachments = await db.select().from(correctionAttachment);
    expect(attachments).toHaveLength(2);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'CORRECTION_RESUBMIT'));
    expect(audits).toHaveLength(1);

    // A resubmission re-enters at PENDING, so it goes back to the VERIFIERS and
    // not forward to the approvers. Without this, getting returned once on
    // purpose would be a way to skip the gate.
    const notes = await db
      .select()
      .from(notification)
      .where(eq(notification.type, 'CORRECTION_RESUBMITTED'));
    expect(notes).toHaveLength(1);
    expect(notes[0].link).toBe(`/verifier/requests/${requestId}`);
  });

  it('re-runs the category rules on the way back in', async () => {
    const { rep, requestId } = await submitThenReturn();

    const result = await resubmitCorrection(rep, {
      requestId,
      proposedValue: 'Maybe',
    });

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(correctionRequest);
    expect(row.status).toBe('RETURNED');
  });

  it('refuses to resubmit anything that is not RETURNED', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();

    const submitted = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    if (!submitted.ok) throw new Error(submitted.error);

    const result = await resubmitCorrection(rep, {
      requestId: submitted.data.id,
      proposedValue: 'No',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/returned request/i);
  });

  it('refuses a resubmission from a rep who is not the submitter', async () => {
    const { requestId } = await submitThenReturn();
    const stranger = sessionFor(await makeUser({ role: 'sales', smId: OTHER_SM_ID }));

    const result = await resubmitCorrection(stranger, { requestId, proposedValue: 'No' });

    expect(result.ok).toBe(false);
    // Same answer as a request that does not exist — ownership is not confirmed
    // to someone who does not have it.
    if (!result.ok) expect(result.error).toMatch(/does not exist/i);
  });

  it('will not let a resubmission push past five proof documents', async () => {
    const { rep, requestId } = await submitThenReturn();

    const result = await resubmitCorrection(rep, {
      requestId,
      proposedValue: 'Yes',
      files: [proof('a.png'), proof('b.png'), proof('c.png'), proof('d.png'), proof('e.png')],
    });

    expect(result.ok).toBe(false);
    expect(await db.select().from(correctionAttachment)).toHaveLength(1);
  });
});

describe('withdrawal (spec 7)', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  async function submitOne(rep: SessionUser, appsNo: string) {
    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    if (!result.ok) throw new Error(result.error);
    return result.data.id;
  }

  it('closes a PENDING request and writes a WITHDRAWN event', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();
    const requestId = await submitOne(rep, record.appsNo);

    const result = await withdrawCorrection(rep, { requestId, reason: 'Raised by mistake.' });
    expect(result.ok).toBe(true);

    const [row] = await db.select().from(correctionRequest);
    // The row must leave the open states or the partial unique index keeps the
    // field locked forever — but it leaves them as WITHDRAWN, not REJECTED.
    // Nobody reviewed this, so the reviewer columns stay empty: putting the
    // rep's own id in "who decided" would misreport their cancellation as an
    // approver's decision everywhere those columns are read.
    expect(row.status).toBe('WITHDRAWN');
    expect(row.reviewedBy).toBeNull();
    expect(row.reviewedAt).toBeNull();
    expect(row.approverRemarks).toBeNull();

    const events = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, requestId))
      .orderBy(correctionEvent.createdAt);
    expect(events.map((e) => e.action)).toEqual(['SUBMITTED', 'WITHDRAWN']);
    expect(events[1].fromStatus).toBe('PENDING');

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'CORRECTION_WITHDRAW'));
    expect(audits).toHaveLength(1);
  });

  it('frees the field so a corrected request can be raised', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();
    const requestId = await submitOne(rep, record.appsNo);

    await withdrawCorrection(rep, { requestId });

    const again = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'No',
      files: [proof()],
    });
    expect(again.ok).toBe(true);
  });

  it('withdraws a RETURNED request', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();
    const requestId = await submitOne(rep, record.appsNo);

    await db
      .update(correctionRequest)
      .set({ status: 'RETURNED' })
      .where(eq(correctionRequest.id, requestId));

    expect((await withdrawCorrection(rep, { requestId })).ok).toBe(true);
  });

  it.each(['APPROVED', 'REJECTED'] as const)(
    'refuses to withdraw a request that is already %s',
    async (status) => {
      const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
      const record = await makeRecord();
      const requestId = await submitOne(rep, record.appsNo);

      await db
        .update(correctionRequest)
        .set({ status })
        .where(eq(correctionRequest.id, requestId));

      const result = await withdrawCorrection(rep, { requestId });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/pending or returned/i);
    },
  );

  it('refuses a withdrawal by anyone but the submitter', async () => {
    const rep = sessionFor(await makeUser({ role: 'sales', smId: OWNER_SM_ID }));
    const record = await makeRecord();
    const requestId = await submitOne(rep, record.appsNo);

    const stranger = sessionFor(await makeUser({ role: 'sales', smId: OTHER_SM_ID }));
    const result = await withdrawCorrection(stranger, { requestId });

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(correctionRequest);
    expect(row.status).toBe('PENDING');
  });
});
