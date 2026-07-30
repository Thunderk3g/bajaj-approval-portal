'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { ApprovalError } from '@/lib/approvals/apply';
import { runBulk } from '@/lib/approvals/bulk';
import type { BulkOutcome } from '@/lib/approvals/schemas';
import {
  returnFromVerification,
  verifyRequest,
  type VerificationOutcome,
} from './apply';
import { bulkVerifierDecisionSchema, verifierDecisionSchema } from './schemas';

/**
 * Verifier decisions — 2026-07-28 spec section 3.
 *
 * `requireRole('verifier')` runs in every action, not only in the layout. A
 * Server Action is a POST endpoint with its own URL: it is reachable without
 * ever rendering the layout that guards the page, so the layout check is a UI
 * affordance and the boundary lives here (base spec section 4.1).
 *
 * Note this is `requireRole('verifier')` alone — an ADMIN cannot verify. Letting
 * the admin who imported the workbook also verify corrections against it would
 * collapse the separation the second stage exists to create, and it would do so
 * silently, because nothing on screen would look different.
 */

async function requestContext() {
  const h = await headers();
  return {
    ipAddress: h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: h.get('user-agent'),
  };
}

function refreshLists() {
  revalidatePath('/verifier');
  revalidatePath('/verifier/queue');
  revalidatePath('/verifier/history');
  // The approver's queue depth changes the moment something is verified.
  revalidatePath('/approver');
  revalidatePath('/approver/queue');
}

function refresh(requestId: string) {
  refreshLists();
  revalidatePath(`/verifier/requests/${requestId}`);
}

function toResult(error: unknown): ActionResult<never> {
  if (error instanceof ApprovalError) return fail(error.message);
  throw error;
}

export async function verifyRequestAction(
  formData: FormData,
): Promise<ActionResult<VerificationOutcome>> {
  const verifier = await requireRole('verifier');

  const parsed = verifierDecisionSchema.safeParse({
    requestId: formData.get('requestId'),
    decision: 'VERIFY',
    remarks: formData.get('remarks') ?? undefined,
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  try {
    const outcome = await verifyRequest({
      requestId: parsed.data.requestId,
      actor: verifier,
      remarks: parsed.data.remarks,
      ...(await requestContext()),
    });
    refresh(parsed.data.requestId);
    return ok(outcome);
  } catch (error) {
    return toResult(error);
  }
}

export async function returnFromVerificationAction(
  formData: FormData,
): Promise<ActionResult<VerificationOutcome>> {
  const verifier = await requireRole('verifier');

  const parsed = verifierDecisionSchema.safeParse({
    requestId: formData.get('requestId'),
    decision: 'RETURN',
    remarks: formData.get('remarks') ?? '',
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  try {
    const outcome = await returnFromVerification({
      requestId: parsed.data.requestId,
      actor: verifier,
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
 * One decision over a selection — the verification queue's batch action.
 *
 * The approver's twin, and the same reasoning: `requireRole('verifier')` runs
 * here because the endpoint is reachable without the page, each id travels the
 * unmodified single-request path so `lockPending` still decides who wins a race,
 * and the batch reports per-request rather than collapsing to a total.
 *
 * `VerificationOutcome` carries no `warnings`, so `runBulk` contributes none —
 * its `warnings ?? []` is what lets the two stages share it without the verifier
 * path having to invent a field it has nothing to put in.
 */
export async function bulkVerifyDecideAction(
  formData: FormData,
): Promise<ActionResult<BulkOutcome>> {
  const verifier = await requireRole('verifier');

  const parsed = bulkVerifierDecisionSchema.safeParse({
    requestIds: formData.getAll('requestIds'),
    decision: formData.get('decision'),
    remarks: formData.get('remarks') ?? '',
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const { requestIds, decision, remarks } = parsed.data;
  const context = await requestContext();
  const input = (requestId: string) => ({ requestId, actor: verifier, remarks, ...context });

  const report = await runBulk(requestIds, (requestId) =>
    decision === 'VERIFY' ? verifyRequest(input(requestId)) : returnFromVerification(input(requestId)),
  );

  refreshLists();
  for (const requestId of report.succeeded) revalidatePath(`/verifier/requests/${requestId}`);

  return ok({
    decision,
    applied: report.succeeded.length,
    failed: report.failed,
    warnings: report.warnings,
  });
}
