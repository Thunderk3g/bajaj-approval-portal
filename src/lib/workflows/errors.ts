/**
 * A workflow-domain failure, thrown rather than returned.
 *
 * Thrown for the same reason `ApprovalError` is: throwing rolls the transaction
 * back, where a returned failure would commit whatever the earlier steps already
 * wrote. `actions.ts` catches it at the boundary and turns it into an
 * `ActionResult` the form can render.
 */
export type WorkflowErrorCode =
  /** No chain is configured for this chainKey, or it is inactive. */
  | 'NO_CHAIN'
  /** A chain exists but has no stages — nothing would ever review the request. */
  | 'EMPTY_CHAIN'
  | 'NOT_FOUND'
  /** The request is not sitting on a stage this actor can decide right now. */
  | 'WRONG_STATUS'
  | 'NOT_AUTHORIZED'
  /** This stage may pass or return, but not reject outright. */
  | 'CANNOT_REJECT'
  | 'INVALID_VALUE';

export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowError';
  }
}
