import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionEvent, correctionRequest, salesRecord } from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import { notifyActiveApprovers, notifyMany } from '@/lib/notifications/service';
import { CATEGORY_LABELS, type CorrectionCategory } from '@/lib/approvals/schemas';
import { ApprovalError, type DecisionActor } from '@/lib/approvals/apply';

/**
 * The verification stage — 2026-07-28 spec section 3.
 *
 * The first of two gates. A request leaves PENDING only through here, and the
 * approval transaction accepts nothing but VERIFIED, so this module is the sole
 * path from "a rep claimed something" to "an approver may act on it".
 *
 * `ApprovalError` is reused rather than a parallel `VerificationError` being
 * introduced. The failures are the same failures — the request vanished, or
 * somebody else already moved it — and the actions layer maps that one type onto
 * the form contract. A second error class would mean two catch branches doing
 * identical work, and a third when the next stage arrives.
 */

export type VerificationOutcome = {
  requestId: string;
  appsNo: string;
  status: 'VERIFIED' | 'RETURNED';
  /**
   * How many approvers were notified. Zero means the request is now in a queue
   * nobody is subscribed to — surfaced to the verifier rather than swallowed,
   * because from the rep's side that is indistinguishable from progress.
   */
  notified: number;
};

export type VerificationInput = {
  requestId: string;
  actor: DecisionActor;
  remarks?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Locks the request at PENDING and returns it, or throws.
 *
 * `FOR UPDATE` on the request row is enough here — unlike approval, nothing
 * touches `sales_record`, so there is no second row two actors could race for.
 * What it does prevent is two verifiers passing the same request, which would
 * write two VERIFIED events and notify the approvers twice for one claim.
 *
 * The status predicate is inside the WHERE, not checked after the read: a
 * check-then-act on a row read outside the lock is exactly the window this is
 * closing.
 */
async function lockPending(tx: DbTransaction, requestId: string) {
  const [request] = await tx
    .select()
    .from(correctionRequest)
    .where(and(eq(correctionRequest.id, requestId), eq(correctionRequest.status, 'PENDING')))
    .limit(1)
    .for('update');

  if (request) return request;

  const [exists] = await tx
    .select({ status: correctionRequest.status })
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!exists) {
    throw new ApprovalError('NOT_FOUND', 'That correction request no longer exists.');
  }

  // Naming the status it actually holds, because the three reachable cases need
  // three different responses from the reader: VERIFIED means a colleague got
  // there first, RETURNED/WITHDRAWN means it went back to the rep, and
  // APPROVED/REJECTED means it is already finished.
  throw new ApprovalError(
    'NOT_PENDING',
    exists.status === 'VERIFIED'
      ? 'Another verifier has already passed this request to the approvers. Reload to see it.'
      : `This request is ${exists.status.toLowerCase()} and is no longer awaiting verification.`,
  );
}

/* ----------------------------------------------------------------- verify */

export async function verifyRequest(input: VerificationInput): Promise<VerificationOutcome> {
  return db.transaction((tx) => verifyWithin(tx, input));
}

/**
 * PENDING → VERIFIED.
 *
 * Deliberately does NOT touch `sales_record`. Verification is an assertion that
 * the claim and its proof hang together, not an application of the change —
 * applying it here would leave the approver deciding whether to keep a change
 * that had already landed, which is a different and much weaker question than
 * the one they are there to answer.
 */
export async function verifyWithin(
  tx: DbTransaction,
  input: VerificationInput,
): Promise<VerificationOutcome> {
  const remarks = input.remarks?.trim() || null;
  const request = await lockPending(tx, input.requestId);
  const verifiedAt = new Date();

  await tx
    .update(correctionRequest)
    .set({ status: 'VERIFIED', verifiedBy: input.actor.id, verifiedAt, verifierRemarks: remarks })
    .where(eq(correctionRequest.id, request.id));

  await tx.insert(correctionEvent).values({
    requestId: request.id,
    action: 'VERIFIED',
    actorId: input.actor.id,
    fromStatus: 'PENDING',
    toStatus: 'VERIFIED',
    remarks,
  });

  await writeAudit(
    {
      actor: input.actor,
      action: 'CORRECTION_VERIFY',
      entityType: 'correction_request',
      entityId: request.id,
      before: { status: 'PENDING' },
      after: { status: 'VERIFIED', verifierRemarks: remarks },
      metadata: {
        appsNo: request.appsNo,
        category: request.category,
        fieldName: request.fieldName,
        submittedBy: request.submittedBy,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  const categoryLabel =
    CATEGORY_LABELS[request.category as CorrectionCategory] ?? request.category;

  const notified = await notifyActiveApprovers(
    {
      type: 'CORRECTION_VERIFIED',
      title: `Verified ${categoryLabel} correction — ${request.appsNo}`,
      body: `${request.fieldLabel}: ${request.originalValue ?? '(blank)'} → ${request.proposedValue}${
        remarks ? ` · Verifier: ${remarks}` : ''
      }`,
      link: `/approver/requests/${request.id}`,
    },
    tx,
  );

  // The rep is told too. Without it, the only observable difference between
  // "waiting on a verifier" and "waiting on an approver" is a status word they
  // would have to go looking for.
  await notifyMany(
    [
      {
        userId: request.submittedBy,
        type: 'CORRECTION_VERIFIED',
        title: `Verified — ${request.appsNo}`,
        body: `Your ${categoryLabel.toLowerCase()} correction passed verification and is now with an approver.`,
        link: `/sales/requests/${request.id}`,
      },
    ],
    tx,
  );

  return { requestId: request.id, appsNo: request.appsNo, status: 'VERIFIED', notified };
}

/* ----------------------------------------------------------------- return */

export async function returnFromVerification(
  input: VerificationInput,
): Promise<VerificationOutcome> {
  return db.transaction((tx) => returnFromVerificationWithin(tx, input));
}

/**
 * PENDING → RETURNED, at the verifier's request.
 *
 * The same terminal status an approver's return produces, on purpose: the
 * request lands in the same place and the rep does the same thing next, so one
 * resubmission path serves both. Which stage sent it back is answered by the
 * actor's role on the event row, which the timeline renders.
 */
export async function returnFromVerificationWithin(
  tx: DbTransaction,
  input: VerificationInput,
): Promise<VerificationOutcome> {
  const remarks = input.remarks?.trim() || null;
  if (!remarks) {
    throw new ApprovalError(
      'INVALID_VALUE',
      'Remarks are required so the submitter knows what to change.',
    );
  }

  const request = await lockPending(tx, input.requestId);
  const decidedAt = new Date();

  // verifiedAt is set even though the outcome is a return: it records that this
  // request was looked at and when, which is what the verifier's own history and
  // the stage-ageing numbers are counted from. verifiedBy names who looked, not
  // who approved — the status column already says the outcome was RETURNED.
  await tx
    .update(correctionRequest)
    .set({
      status: 'RETURNED',
      verifiedBy: input.actor.id,
      verifiedAt: decidedAt,
      verifierRemarks: remarks,
    })
    .where(eq(correctionRequest.id, request.id));

  await tx.insert(correctionEvent).values({
    requestId: request.id,
    action: 'RETURNED',
    actorId: input.actor.id,
    fromStatus: 'PENDING',
    toStatus: 'RETURNED',
    remarks,
  });

  await writeAudit(
    {
      actor: input.actor,
      action: 'CORRECTION_RETURN_VERIFIER',
      entityType: 'correction_request',
      entityId: request.id,
      before: { status: 'PENDING' },
      after: { status: 'RETURNED', verifierRemarks: remarks },
      metadata: {
        appsNo: request.appsNo,
        category: request.category,
        fieldName: request.fieldName,
        submittedBy: request.submittedBy,
        stage: 'VERIFICATION',
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  await notifyMany(
    [
      {
        userId: request.submittedBy,
        type: 'CORRECTION_RETURNED_BY_VERIFIER',
        title: `More information needed — ${request.appsNo}`,
        body: remarks,
        link: `/sales/requests/${request.id}`,
      },
    ],
    tx,
  );

  return { requestId: request.id, appsNo: request.appsNo, status: 'RETURNED', notified: 0 };
}

/* ---------------------------------------------------------------- preview */

/**
 * Whether the record still holds the value the request claims it does.
 *
 * A verifier decides against the record as it is now, not as it was when the
 * request was raised — a re-import or another approved correction may have
 * changed the field in between, which would make the comparison on screen a
 * description of a state that no longer exists.
 */
export async function liveValueDrifted(
  requestId: string,
): Promise<{ drifted: boolean; live: string | null; claimed: string | null }> {
  const [row] = await db
    .select({
      fieldName: correctionRequest.fieldName,
      originalValue: correctionRequest.originalValue,
      record: salesRecord,
    })
    .from(correctionRequest)
    .innerJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!row) return { drifted: false, live: null, claimed: null };

  const raw = (row.record as unknown as Record<string, unknown>)[row.fieldName];
  const live =
    raw === null || raw === undefined
      ? null
      : raw instanceof Date
        ? raw.toISOString().slice(0, 10)
        : String(raw);

  return { drifted: live !== row.originalValue, live, claimed: row.originalValue };
}
