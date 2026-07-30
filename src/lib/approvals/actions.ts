'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import {
  ApprovalError,
  applyApproval,
  rejectRequest,
  returnRequest,
  type ApprovalOutcome,
  type DecisionOutcome,
} from './apply';
import { runBulk } from './bulk';
import { bulkDecisionSchema, decisionSchema, type BulkOutcome } from './schemas';

/**
 * Approver decisions — spec section 7.
 *
 * Every action re-checks the role itself. `/approver/layout.tsx` and the
 * middleware both gate the *page*, but a Server Action is a POST endpoint with
 * its own URL: it is reachable without ever rendering the layout, so a layout
 * check is a UI affordance and not an authorization boundary (spec 4.1).
 *
 * AuthzError is deliberately not caught here — the layout turns it into a
 * redirect, and swallowing it would render "an error occurred" to someone whose
 * real problem is an expired session.
 */

async function requestContext() {
  const h = await headers();
  return {
    // x-forwarded-for is the only address available behind the reverse proxy;
    // the first hop is the client. Recorded for the audit row, never trusted for
    // authorization.
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent'),
  };
}

function refreshLists() {
  revalidatePath('/approver');
  revalidatePath('/approver/queue');
  revalidatePath('/approver/history');
}

function refresh(requestId: string) {
  refreshLists();
  revalidatePath(`/approver/requests/${requestId}`);
}

/** Maps a domain failure onto the form contract; anything else keeps throwing. */
function toResult(error: unknown): ActionResult<never> {
  if (error instanceof ApprovalError) return fail(error.message);
  throw error;
}

export async function approveRequestAction(
  formData: FormData,
): Promise<ActionResult<ApprovalOutcome>> {
  const approver = await requireRole('approver');

  const parsed = decisionSchema.safeParse({
    requestId: formData.get('requestId'),
    decision: 'APPROVE',
    remarks: formData.get('remarks') ?? undefined,
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  try {
    const outcome = await applyApproval({
      requestId: parsed.data.requestId,
      actor: approver,
      remarks: parsed.data.remarks,
      ...(await requestContext()),
    });
    refresh(parsed.data.requestId);
    return ok(outcome);
  } catch (error) {
    return toResult(error);
  }
}

export async function rejectRequestAction(
  formData: FormData,
): Promise<ActionResult<DecisionOutcome>> {
  const approver = await requireRole('approver');

  const parsed = decisionSchema.safeParse({
    requestId: formData.get('requestId'),
    decision: 'REJECT',
    remarks: formData.get('remarks') ?? '',
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  try {
    const outcome = await rejectRequest({
      requestId: parsed.data.requestId,
      actor: approver,
      remarks: parsed.data.remarks,
      ...(await requestContext()),
    });
    refresh(parsed.data.requestId);
    return ok(outcome);
  } catch (error) {
    return toResult(error);
  }
}

export async function returnRequestAction(
  formData: FormData,
): Promise<ActionResult<DecisionOutcome>> {
  const approver = await requireRole('approver');

  const parsed = decisionSchema.safeParse({
    requestId: formData.get('requestId'),
    decision: 'RETURN',
    remarks: formData.get('remarks') ?? '',
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  try {
    const outcome = await returnRequest({
      requestId: parsed.data.requestId,
      actor: approver,
      remarks: parsed.data.remarks,
      ...(await requestContext()),
    });
    refresh(parsed.data.requestId);
    return ok(outcome);
  } catch (error) {
    return toResult(error);
  }
}

/**
 * One decision over a selection — the queue's batch action.
 *
 * `requireRole('approver')` runs here exactly as it does on the single-request
 * actions, and `applyApproval`/`rejectRequest`/`returnRequest` each re-assert it
 * through `assertApprover` besides. Deciding forty requests at once changes the
 * volume, not the boundary: this is still a POST endpoint reachable without the
 * queue page, so it re-checks the role, re-validates the payload, and re-reads
 * every request under its own lock.
 *
 * Nothing about the per-request path is bypassed or reimplemented here. Each id
 * goes through the identical function the detail screen calls, which is what
 * makes the verifier gate, the version bump, the audit pair and both
 * notifications hold for a batched decision as strongly as for a typed one.
 */
export async function bulkDecideAction(formData: FormData): Promise<ActionResult<BulkOutcome>> {
  const approver = await requireRole('approver');

  const parsed = bulkDecisionSchema.safeParse({
    requestIds: formData.getAll('requestIds'),
    decision: formData.get('decision'),
    remarks: formData.get('remarks') ?? '',
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const { requestIds, decision, remarks } = parsed.data;
  const context = await requestContext();
  const input = (requestId: string) => ({ requestId, actor: approver, remarks, ...context });

  // `async` so the three branches collapse to one Promise of a union rather than
  // a union of Promises, which is not what `runBulk`'s single type parameter
  // takes.
  const report = await runBulk(requestIds, async (requestId) => {
    if (decision === 'APPROVE') return applyApproval(input(requestId));
    if (decision === 'REJECT') return rejectRequest(input(requestId));
    return returnRequest(input(requestId));
  });

  // The lists always change — even an all-failed batch leaves the counts as they
  // were, and re-rendering them is what shows the approver the current truth
  // rather than the page they pressed the button on. Detail paths are
  // invalidated only for the ones that actually moved.
  refreshLists();
  for (const requestId of report.succeeded) revalidatePath(`/approver/requests/${requestId}`);

  return ok({
    decision,
    applied: report.succeeded.length,
    failed: report.failed,
    warnings: report.warnings,
  });
}
