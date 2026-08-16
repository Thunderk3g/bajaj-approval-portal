import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, salesRecord } from '@/db/schema';
// The barrel, not `@/lib/workflows/engine` — see the note in decide-action.ts.
// A verifier clearing rung zero of a mapping chain has to OPEN the TL rung after
// it, and opening it resolves `TL_OF_SM`, which is registered only by the front
// door.
import { decideStage, type DecideStageOutcome } from '@/lib/workflows';
import { WorkflowError } from '@/lib/workflows/errors';
import { ApprovalError, type DecisionActor } from '@/lib/approvals/record-apply';

/**
 * The verification stage — 2026-07-28 spec section 3, now the first rung of a
 * configurable chain (2026-08-06 spec section 4).
 *
 * These two functions are adapters, not a second state machine. Under the
 * two-stage chains every category ships with, "verify" is exactly "advance the
 * first rung" and "return from verification" is exactly "return it", so the verbs
 * the verifier UI and its tests already speak map straight through. Under a
 * longer chain the same verb advances whichever rung that verifier is actually
 * standing on, which is what makes a mapping request's V2 work without a third
 * module appearing beside this one.
 *
 * `ApprovalError` is reused rather than a parallel `VerificationError` being
 * introduced. The failures are the same failures — the request vanished, or
 * somebody else already moved it — and the actions layer maps that one type onto
 * the form contract.
 */

export type VerificationOutcome = {
  requestId: string;
  appsNo: string;
  status: 'VERIFIED' | 'RETURNED';
  /**
   * How many people were notified at the next rung. Zero means the request is
   * now in a queue nobody is subscribed to — surfaced to the verifier rather than
   * swallowed, because from the rep's side that is indistinguishable from
   * progress.
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

async function viaEngine(
  input: VerificationInput,
  decision: 'ADVANCE' | 'RETURN',
): Promise<DecideStageOutcome> {
  try {
    return await decideStage({ ...input, decision });
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw new ApprovalError(
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'INVALID_VALUE'
            ? 'INVALID_VALUE'
            : 'NOT_PENDING',
        error.message,
      );
    }
    throw error;
  }
}

/**
 * Passes the rung this verifier is standing on.
 *
 * Deliberately does NOT touch `sales_record` unless the rung it advances is the
 * LAST one. Verification is an assertion that the claim and its proof hang
 * together, not an application of the change — applying it early would leave the
 * next reviewer deciding whether to keep a change that had already landed, which
 * is a different and much weaker question than the one they are there to answer.
 * Under the standard chains the last rung is always an approver's, so this
 * function never applies anything; the guard below says so out loud rather than
 * relying on that staying true.
 */
export async function verifyRequest(input: VerificationInput): Promise<VerificationOutcome> {
  const outcome = await viaEngine(input, 'ADVANCE');

  if (outcome.kind === 'APPLIED') {
    // Reachable only from a chain whose final rung resolves to a verifier, which
    // no shipped chain does. Reported rather than silently returning VERIFIED:
    // the record HAS changed, and a caller told otherwise would show the rep a
    // request still in review.
    throw new ApprovalError(
      'NOT_PENDING',
      'That step was the final one and applied the correction directly. Reload to see the result.',
    );
  }
  if (outcome.kind !== 'ADVANCED') {
    throw new ApprovalError('NOT_PENDING', `This request was ${outcome.kind.toLowerCase()}.`);
  }

  return {
    requestId: outcome.requestId,
    appsNo: outcome.appsNo,
    status: 'VERIFIED',
    notified: outcome.notified,
  };
}

/**
 * Sends the request back to the submitter.
 *
 * The same terminal status an approver's return produces, on purpose: the request
 * lands in the same place and the rep does the same thing next, so one
 * resubmission path serves both. Which rung sent it back is answered by the
 * `stage_key` on the event row, which the timeline renders.
 */
export async function returnFromVerification(
  input: VerificationInput,
): Promise<VerificationOutcome> {
  const outcome = await viaEngine(input, 'RETURN');

  if (outcome.kind !== 'RETURNED') {
    throw new ApprovalError('NOT_PENDING', 'That decision did not return the request.');
  }

  return {
    requestId: outcome.requestId,
    appsNo: outcome.appsNo,
    status: 'RETURNED',
    notified: 0,
  };
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
