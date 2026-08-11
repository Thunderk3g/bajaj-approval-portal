import { decideStage, decideStageWithin, type DecideStageOutcome } from '@/lib/workflows/engine';
import { WorkflowError } from '@/lib/workflows/errors';
import type { DbTransaction } from '@/lib/audit/log';
import { ApprovalError, type ApprovalErrorCode, type DecisionActor } from './record-apply';

/**
 * The approval stage, as the rest of the application still calls it.
 *
 * Every function here is now a thin adapter over the N-stage engine (2026-08-06
 * spec section 4). The transitions themselves moved, because with a configurable
 * chain there is no longer a fixed "the approver decides second" — but the four
 * verbs the actions, the bulk runner and the tests already speak are unchanged,
 * so nothing above this line had to learn a new vocabulary in the same release
 * that changed what happens underneath it.
 *
 * Two rules make the adapters honest rather than a second implementation:
 *
 *   * They add NO gating of their own. Whether this actor may decide this rung is
 *     the engine's question, and asking it twice in two places is how the two
 *     answers drift apart.
 *   * They translate the engine's error type into this module's. `actions.ts`
 *     catches `ApprovalError` to build its form result; leaving a `WorkflowError`
 *     to escape would turn a "you cannot do that" into an unhandled 500.
 */

export * from './record-apply';

/**
 * The status an approver may act on — 2026-07-28 spec section 3.4.
 *
 * Retained because queries, page guards and tests read it to decide what to
 * render. It is no longer the gate: what an actor may decide is now the ACTIVE
 * rung of that request's own chain, checked inside `decideStageWithin` under the
 * same lock that stops two people deciding at once. A chain of three stages puts
 * a request in VERIFIED for rungs 1 and 2 alike, so this constant answers "is it
 * past the first gate", not "is it with the approver".
 */
export const APPROVABLE_STATUS = 'VERIFIED' as const;

export type DecisionInput = {
  requestId: string;
  actor: DecisionActor;
  remarks?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type ApprovalOutcome = {
  requestId: string;
  /**
   * No `recordId`, deliberately.
   *
   * This field used to exist and was filled with `outcome.requestId` — the
   * request's id under the record's name. `DecideStageOutcome` carries no record
   * id, so there was never a correct value to put there, and every caller that
   * trusted it would have loaded the wrong row (or, more likely, none at all).
   * A field nobody reads is cheaper to delete than to keep truthful; if a caller
   * ever needs it, `decideStageWithin` should return it rather than this adapter
   * inventing it. `appsNo` below identifies the record for every current caller.
   */
  appsNo: string;
  fieldName: string;
  fieldLabel: string;
  previousValue: string | null;
  newValue: string | null;
  /** The version row that carries the approved value — the record's new current. */
  appliedVersion: number;
  /**
   * Facts the approver must see afterwards that must not block the decision —
   * an SM_ID missing from the roster, a rep with no portal account. Blocking on
   * these would stall reconciliation behind data the approver cannot fix.
   */
  warnings: string[];
};

export type DecisionOutcome = {
  requestId: string;
  appsNo: string;
  status: 'REJECTED' | 'RETURNED';
};

/**
 * `WorkflowError` codes carry more detail than `ApprovalError` has room for, and
 * every extra one collapses onto NOT_PENDING — the code this module has always
 * used for "the row is not in the state this transition starts from". The MESSAGE
 * is what reaches the user and it is passed through untouched, so the reader
 * still learns whether they were too early, too late, or not the right person.
 */
const CODE_MAP: Record<string, ApprovalErrorCode> = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_VALUE: 'INVALID_VALUE',
  NO_CHAIN: 'NOT_PENDING',
  EMPTY_CHAIN: 'NOT_PENDING',
  WRONG_STATUS: 'NOT_PENDING',
  NOT_AUTHORIZED: 'NOT_PENDING',
  CANNOT_REJECT: 'NOT_PENDING',
};

async function viaEngine<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw new ApprovalError(CODE_MAP[error.code] ?? 'NOT_PENDING', error.message);
    }
    throw error;
  }
}

/* ---------------------------------------------------------------- approval */

export async function applyApproval(input: DecisionInput): Promise<ApprovalOutcome> {
  const outcome = await viaEngine(() => decideStage({ ...input, decision: 'ADVANCE' }));
  return asApprovalOutcome(outcome);
}

/**
 * The same approval, composed into a transaction the caller already holds.
 *
 * Kept because atomicity is only testable from outside: a caller that throws
 * after this returns must leave nothing behind, and proving that needs the
 * approval and the throw on one transaction. It also means a future caller that
 * approves as part of a larger unit of work composes with it instead of nesting a
 * second transaction inside the first.
 */
export async function applyApprovalWithin(
  tx: DbTransaction,
  input: DecisionInput,
): Promise<ApprovalOutcome> {
  const outcome = await viaEngine(() =>
    decideStageWithin(tx, { ...input, decision: 'ADVANCE' }),
  );
  return asApprovalOutcome(outcome);
}

/**
 * Turns the engine's union into the shape this module has always returned.
 *
 * `ADVANCED` reaching here means the request moved to another rung instead of
 * being applied — which under a two-stage chain cannot happen to an approver, and
 * under a longer one means the caller used the wrong verb. Reported rather than
 * coerced into a fake `appliedVersion`, because a caller that believes a record
 * changed when it did not will go looking for a version row that was never
 * written.
 */
function asApprovalOutcome(outcome: DecideStageOutcome): ApprovalOutcome {
  if (outcome.kind !== 'APPLIED') {
    throw new ApprovalError(
      'NOT_PENDING',
      outcome.kind === 'ADVANCED'
        ? `This request still has "${outcome.nextStageKey}" to clear before it can be applied.`
        : `This request was ${outcome.kind.toLowerCase()} rather than applied.`,
    );
  }

  return {
    requestId: outcome.requestId,
    appsNo: outcome.appsNo,
    fieldName: outcome.fieldName,
    fieldLabel: outcome.fieldLabel,
    previousValue: outcome.previousValue,
    newValue: outcome.newValue,
    appliedVersion: outcome.appliedVersion,
    warnings: outcome.warnings,
  };
}

/* ------------------------------------------------------- reject and return */

export async function rejectRequest(input: DecisionInput): Promise<DecisionOutcome> {
  const outcome = await viaEngine(() => decideStage({ ...input, decision: 'REJECT' }));
  return asDecisionOutcome(outcome);
}

export async function returnRequest(input: DecisionInput): Promise<DecisionOutcome> {
  const outcome = await viaEngine(() => decideStage({ ...input, decision: 'RETURN' }));
  return asDecisionOutcome(outcome);
}

function asDecisionOutcome(outcome: DecideStageOutcome): DecisionOutcome {
  if (outcome.kind !== 'REJECTED' && outcome.kind !== 'RETURNED') {
    throw new ApprovalError('NOT_PENDING', 'That decision did not close the request.');
  }
  return { requestId: outcome.requestId, appsNo: outcome.appsNo, status: outcome.kind };
}
