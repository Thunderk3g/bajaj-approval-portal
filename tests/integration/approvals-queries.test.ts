import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionEvent, correctionRequest, manpower, salesRecord } from '@/db/schema';
import { getRequestDetail, listHistory, listQueue, queueCounts } from '@/lib/approvals/queries';
import { applyApproval, previewTarget, returnRequest } from '@/lib/approvals/apply';
import { parseHistoryFilters, parseQueueFilters } from '@/lib/approvals/schemas';
import { verifyRequest } from '@/lib/verification/apply';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The read layer runs against a real database for one reason: a correlated
 * subquery, an aliased self-join and a `for update` clause all typecheck
 * perfectly while producing invalid SQL. Only execution proves them.
 */

const OWNER = 'ICCSP90766';
const page = { page: 1, pageSize: 25, offset: 0 };

async function seed() {
  const rep = await makeUser({ role: 'sales', smId: OWNER, name: 'Priya Sales' });
  const approverRow = await makeUser({ role: 'approver', smId: null, name: 'Anand Approver' });
  const approver = { id: approverRow.id, email: approverRow.email, role: 'approver' as const };
  const verifierRow = await makeUser({ role: 'verifier', smId: null, name: 'Vidya Verifier' });
  const verifier = { id: verifierRow.id, email: verifierRow.email, role: 'verifier' as const };

  const [record] = await db
    .insert(salesRecord)
    .values({ appsNo: '6167509575', smId: OWNER, clientName: 'Meera Nair', status: 'ISSUED' })
    .returning();

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
      // Seeded in the state the APPROVER's queue reads — verified. Since the
      // 2026-07-28 gate, PENDING means "with a verifier" and never appears in
      // the approver's default scope, so a PENDING fixture would make every
      // assertion below trivially zero.
      status: 'VERIFIED',
      verifiedBy: verifierRow.id,
      verifiedAt: new Date(Date.now() - 8 * 86_400_000),
      // Backdated so the ageing column has something to report. Ageing runs from
      // submission, not verification: the rep has been waiting since they filed.
      submittedAt: new Date(Date.now() - 9 * 86_400_000),
    })
    .returning();

  await db.insert(correctionEvent).values([
    { requestId: request.id, action: 'SUBMITTED', actorId: rep.id, toStatus: 'PENDING' },
    {
      requestId: request.id,
      action: 'VERIFIED',
      actorId: verifierRow.id,
      fromStatus: 'PENDING',
      toStatus: 'VERIFIED',
    },
  ]);

  await db.insert(correctionAttachment).values({
    requestId: request.id,
    storedPath: 'proofs/2026/07/mandate.png',
    originalName: 'mandate.png',
    mimeType: 'image/png',
    sizeBytes: 51_200,
    sha256: 'a'.repeat(64),
    uploadedBy: rep.id,
  });

  return { rep, approver, verifier, record, request };
}

describe('the pending queue (spec 9)', () => {
  beforeEach(truncateAll);

  it('lists open requests oldest first with ageing, submitter and proof count', async () => {
    const { request } = await seed();

    const queue = await listQueue(parseQueueFilters({}), page);

    expect(queue.total).toBe(1);
    expect(queue.rows[0].id).toBe(request.id);
    expect(queue.rows[0].ageDays).toBe(9);
    expect(queue.rows[0].submitterName).toBe('Priya Sales');
    expect(queue.rows[0].clientName).toBe('Meera Nair');
    expect(queue.rows[0].attachments).toBe(1);
  });

  it('separates what needs a decision from what is waiting on the submitter', async () => {
    const { approver, request } = await seed();

    await returnRequest({ requestId: request.id, actor: approver, remarks: 'Attach the mandate.' });

    expect((await listQueue(parseQueueFilters({}), page)).total).toBe(0);
    expect((await listQueue(parseQueueFilters({ scope: 'RETURNED' }), page)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ scope: 'OPEN' }), page)).total).toBe(1);

    const counts = await queueCounts();
    expect(counts).toMatchObject({ awaitingDecision: 0, awaitingVerification: 0, returned: 1 });
  });

  it('filters by category and searches across application, rep and client', async () => {
    await seed();

    expect((await listQueue(parseQueueFilters({ category: 'MAPPING' }), page)).total).toBe(0);
    expect((await listQueue(parseQueueFilters({ category: 'AUTOPAY' }), page)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ q: 'Meera' }), page)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ q: '61675' }), page)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ q: 'nobody' }), page)).total).toBe(0);
  });
});

describe('decision history (spec 5.8)', () => {
  beforeEach(truncateAll);

  it('keeps a return that was later resubmitted and approved', async () => {
    const { rep, approver, verifier, request } = await seed();

    await returnRequest({ requestId: request.id, actor: approver, remarks: 'Unreadable proof.' });

    // The resubmission re-enters at PENDING and has to clear verification again
    // before the approver can act — stood in for here, since the sales action
    // and the verification service each own their own transition.
    await db
      .update(correctionRequest)
      .set({ status: 'PENDING', resubmissionCount: 1, lastResubmittedAt: new Date() })
      .where(eq(correctionRequest.id, request.id));
    await db.insert(correctionEvent).values({
      requestId: request.id,
      action: 'RESUBMITTED',
      actorId: rep.id,
      fromStatus: 'RETURNED',
      toStatus: 'PENDING',
    });

    await verifyRequest({ requestId: request.id, actor: verifier });
    await applyApproval({ requestId: request.id, actor: approver });

    const history = await listHistory(parseHistoryFilters({}), page, approver.id);

    // The request row now says APPROVED and has forgotten the return entirely.
    expect(history.rows.map((r) => r.action)).toEqual(['APPROVED', 'RETURNED']);
    expect(history.rows.every((r) => r.currentStatus === 'APPROVED')).toBe(true);
    expect(history.rows[0].actorName).toBe('Anand Approver');

    expect(
      (await listHistory(parseHistoryFilters({ action: 'RETURNED' }), page, approver.id)).total,
    ).toBe(1);
    expect((await listHistory(parseHistoryFilters({ mine: '1' }), page, approver.id)).total).toBe(2);
  });
});

describe('the decision screen payload (spec 7.2, 9)', () => {
  beforeEach(truncateAll);

  it('carries the request, record, proofs and timeline in one read', async () => {
    const { request, record } = await seed();

    const detail = await getRequestDetail(request.id);
    expect(detail).not.toBeNull();
    expect(detail!.record.id).toBe(record.id);
    expect(detail!.submitterName).toBe('Priya Sales');
    expect(detail!.attachments).toHaveLength(1);
    // The approver sees both stages on one payload: the rep's submission and
    // the verification that put it in front of them.
    expect(detail!.events.map((e) => e.action)).toEqual(['SUBMITTED', 'VERIFIED']);
    expect(detail!.verifierName).toBe('Vidya Verifier');
    expect(detail!.mapping).toBeNull();

    const preview = previewTarget(detail!.request, detail!.record);
    expect(preview).toMatchObject({ fieldKey: 'autopay', label: 'AutoPay', problem: null });
  });

  it('shows both reps side by side on a mapping claim, roster and account included', async () => {
    const { rep, record } = await seed();
    await db.insert(manpower).values({ smId: 'C2CM21350', smName: 'Ravi Kumar' });
    const claimant = await makeUser({ role: 'sales', smId: 'C2CM21350', name: 'Ravi Kumar' });

    const [claim] = await db
      .insert(correctionRequest)
      .values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'MAPPING',
        direction: 'CLAIM_IN',
        fieldName: 'smId',
        fieldLabel: 'SM ID',
        originalValue: OWNER,
        proposedValue: 'c2cm21350',
        submittedBy: claimant.id,
        smId: 'C2CM21350',
      })
      .returning();

    const detail = await getRequestDetail(claim.id);
    expect(detail!.mapping).toMatchObject({
      currentSmId: OWNER,
      currentAccount: { name: 'Priya Sales', email: rep.email },
      // Uppercased for the lookup: the roster and the record both store it that way.
      claimSmId: 'C2CM21350',
      claimRosterName: 'Ravi Kumar',
      claimInRoster: true,
    });
  });

  it('reports an unapplicable proposal instead of throwing on the read path', async () => {
    const { rep, record } = await seed();

    const [broken] = await db
      .insert(correctionRequest)
      .values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'ISSUANCE_DATE',
        fieldName: 'issuedDate',
        fieldLabel: 'Issued date',
        proposedValue: 'sometime in June',
        submittedBy: rep.id,
        smId: OWNER,
      })
      .returning();

    const detail = await getRequestDetail(broken.id);
    const preview = previewTarget(detail!.request, detail!.record);
    expect(preview.problem).toMatch(/date/i);
  });
});
