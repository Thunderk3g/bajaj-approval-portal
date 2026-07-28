'use server';

import { headers } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { ApprovalError } from '@/lib/approvals/apply';
import {
  returnFromVerification,
  verifyRequest,
  type VerificationOutcome,
} from './apply';
import { verifierDecisionSchema } from './schemas';

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

function refresh(requestId: string) {
  revalidatePath('/verifier');
  revalidatePath('/verifier/queue');
  revalidatePath('/verifier/history');
  revalidatePath(`/verifier/requests/${requestId}`);
  // The approver's queue depth changes the moment something is verified.
  revalidatePath('/approver');
  revalidatePath('/approver/queue');
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
