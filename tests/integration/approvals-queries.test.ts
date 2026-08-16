import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionEvent, correctionRequest, manpower, salesRecord } from '@/db/schema';
import { getRequestDetail, listHistory, listQueue, queueCounts } from '@/lib/approvals/queries';
import { applyApproval, previewTarget, returnRequest } from '@/lib/approvals/apply';
import { parseHistoryFilters, parseQueueFilters } from '@/lib/approvals/schemas';
import { verifyRequest } from '@/lib/verification/apply';
import { makeUser, sessionFor, truncateAll } from '../helpers/db';

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

  return { rep, approverRow, approver, verifier, record, request };
}

describe('the pending queue (spec 9)', () => {
  beforeEach(truncateAll);

  /**
   * Explicit `scope: 'OPEN'`, not the default.
   *
   * The default is now `MINE`, which reads the STAGE table — and these cases
   * seed a request row directly rather than through `submitCorrection`, so it
   * has no materialised stages at all. That is the right seed for what they
   * test (the projection, the ageing, the search) and the wrong one for scope
   * semantics, which `queue-bulk-gate.test.ts` and `approver-page-gate.test.ts`
   * cover against real stage rows. Naming the scope keeps each file testing one
   * thing.
   */
  it('lists open requests oldest first with ageing, submitter and proof count', async () => {
    const { request, approverRow } = await seed();

    const queue = await listQueue(
      parseQueueFilters({ scope: 'OPEN' }),
      page,
      sessionFor(approverRow),
    );

    expect(queue.total).toBe(1);
    expect(queue.rows[0].id).toBe(request.id);
    expect(queue.rows[0].ageDays).toBe(9);
    expect(queue.rows[0].submitterName).toBe('Priya Sales');
    expect(queue.rows[0].clientName).toBe('Meera Nair');
    expect(queue.rows[0].attachments).toBe(1);
  });

  it('separates what needs a decision from what is waiting on the submitter', async () => {
    const { approver, approverRow, request } = await seed();
    const session = sessionFor(approverRow);

    await returnRequest({ requestId: request.id, actor: approver, remarks: 'Attach the mandate.' });

    expect((await listQueue(parseQueueFilters({ scope: 'VERIFIED' }), page, session)).total).toBe(0);
    expect((await listQueue(parseQueueFilters({ scope: 'RETURNED' }), page, session)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ scope: 'OPEN' }), page, session)).total).toBe(1);

    const counts = await queueCounts(session);
    expect(counts).toMatchObject({ awaitingDecision: 0, awaitingVerification: 0, returned: 1 });
  });

  it('filters by category and searches across application, rep and client', async () => {
    const { approverRow } = await seed();
    const session = sessionFor(approverRow);

    expect((await listQueue(parseQueueFilters({ scope: 'OPEN', category: 'MAPPING' }), page, session)).total).toBe(0);
    expect((await listQueue(parseQueueFilters({ scope: 'OPEN', category: 'AUTOPAY' }), page, session)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ scope: 'OPEN', q: 'Meera' }), page, session)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ scope: 'OPEN', q: '61675' }), page, session)).total).toBe(1);
    expect((await listQueue(parseQueueFilters({ scope: 'OPEN', q: 'nobody' }), page, session)).total).toBe(0);
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
    const { request, record, approverRow } = await seed();

    const detail = await getRequestDetail(sessionFor(approverRow), request.id);
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
    const { rep, record, approverRow } = await seed();
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

    const detail = await getRequestDetail(sessionFor(approverRow), claim.id);
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
    const { rep, record, approverRow } = await seed();

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

    const detail = await getRequestDetail(sessionFor(approverRow), broken.id);
    const preview = previewTarget(detail!.request, detail!.record);
    expect(preview.problem).toMatch(/date/i);
  });
});
