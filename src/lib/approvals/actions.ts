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
import { decisionSchema } from './schemas';

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

function refresh(requestId: string) {
  revalidatePath('/approver');
  revalidatePath('/approver/queue');
  revalidatePath('/approver/history');
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
