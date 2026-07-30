import { ApprovalError } from './apply';

/**
 * Runs one decision over many requests — the batch half of spec section 7.
 *
 * The whole design is in one sentence: ONE TRANSACTION PER REQUEST, never one
 * around the batch. A single transaction would mean the fiftieth request's bad
 * issuance date rolls back the forty-nine approvals already applied, and the
 * approver — who checked all fifty — is told nothing happened. Worse, it would
 * hold a row lock on every touched `sales_record` for the length of the batch,
 * which is exactly when reps are submitting against those same records.
 *
 * Partial success is therefore the normal outcome, not a degraded one, and the
 * report below is the contract that makes it legible: what applied, and for each
 * that did not, why. A caller that renders only the count is hiding the half the
 * approver has to act on.
 */

export type BulkFailure = { requestId: string; message: string };

export type BulkReport = {
  /** Request ids that committed, in the order they were decided. */
  succeeded: string[];
  failed: BulkFailure[];
  /**
   * Non-blocking facts from the successful decisions, deduplicated.
   *
   * Approving fifty mapping claims that all name one unrostered SM_ID produces
   * fifty identical warnings, and fifty copies of a sentence is how the one
   * warning that differs gets missed.
   */
  warnings: string[];
};

/**
 * Sequential, deliberately — not `Promise.all`.
 *
 * Two requests in the same batch can target the same `sales_record`, and
 * `applyApprovalWithin` takes `FOR UPDATE` on it. Run concurrently, those two
 * transactions queue on the same row while both hold a connection, and a batch
 * larger than the pool deadlocks against itself. Running them in order costs
 * wall-clock time an approver spends once a month and removes the failure mode
 * entirely.
 */
export async function runBulk<T extends object>(
  requestIds: readonly string[],
  decide: (requestId: string) => Promise<T>,
): Promise<BulkReport> {
  const succeeded: string[] = [];
  const failed: BulkFailure[] = [];
  const warnings = new Set<string>();

  for (const requestId of requestIds) {
    try {
      const outcome = await decide(requestId);
      succeeded.push(requestId);
      // Read off the outcome rather than demanded by the type parameter: only
      // the approval path produces warnings, and a constraint requiring the
      // field would force `VerificationOutcome` to declare one it never fills.
      for (const warning of (outcome as { warnings?: readonly string[] }).warnings ?? []) {
        warnings.add(warning);
      }
    } catch (error) {
      /*
       * Everything is caught, including errors that are not domain failures.
       *
       * The single-request actions re-throw anything that is not an
       * `ApprovalError`, and that is right there: one request, one decision,
       * nothing committed, so a stack trace is the honest answer. Here it is
       * not — by the time an unexpected error arrives, earlier requests have
       * already COMMITTED, and letting it propagate would abandon the batch
       * with no record of which ones landed. The approver would have no way to
       * tell an applied correction from a skipped one except by re-reading the
       * queue row by row.
       *
       * So the batch always completes and always reports. The unexpected error
       * still reaches the server log in full; what the approver gets is a line
       * naming the request it belongs to.
       */
      if (error instanceof ApprovalError) {
        failed.push({ requestId, message: error.message });
      } else {
        console.error(`bulk decision failed for request ${requestId}`, error);
        failed.push({
          requestId,
          message: 'An unexpected error stopped this one. It was left untouched — check the server log.',
        });
      }
    }
  }

  return { succeeded, failed, warnings: [...warnings] };
}
