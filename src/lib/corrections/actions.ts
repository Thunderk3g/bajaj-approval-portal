'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { type ActionResult, fail } from '@/lib/result';
import { MAX_PROOFS_PER_REQUEST, type ProofUpload } from '@/lib/storage/files';
import { lookupRecordByAppsNo, type LookupOutcome } from './lookup';
import { resubmitCorrection, submitCorrection, withdrawCorrection } from './service';

/**
 * The sales-side Server Actions.
 *
 * Every one of them calls `requireRole('sales')` itself. Middleware redirects
 * the wrong role away from the page, but a Server Action is an HTTP endpoint
 * with a stable id: it can be invoked directly, with no page and no middleware
 * in front of it, so the check has to live here (spec section 4.1). These
 * wrappers hold the authorization and the form decoding, and nothing else — the
 * work is in `service.ts`, which is reachable no other way.
 */

/** Roughly 55 MB of base64 — five 10 MB files plus multipart overhead. */
const MAX_FORM_FILE_COUNT = MAX_PROOFS_PER_REQUEST;

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Reads the uploaded files into memory.
 *
 * Bounded before anything is read: `getAll` on a hand-crafted request can carry
 * any number of parts, and reading them all to find out there were two hundred
 * is the denial of service. The count is checked first, the bytes second.
 */
async function readFiles(form: FormData, key = 'files'): Promise<ProofUpload[] | { error: string }> {
  const entries = form.getAll(key).filter((entry): entry is File => entry instanceof File);
  const present = entries.filter((file) => file.size > 0);

  if (present.length > MAX_FORM_FILE_COUNT) {
    return { error: `Attach at most ${MAX_FORM_FILE_COUNT} proof documents.` };
  }

  return Promise.all(
    present.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

export async function submitCorrectionAction(
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole('sales');

  const files = await readFiles(form);
  if ('error' in files) return fail(files.error, { files: [files.error] });

  const result = await submitCorrection(actor, {
    category: text(form, 'category'),
    direction: text(form, 'direction'),
    appsNo: text(form, 'appsNo'),
    proposedValue: text(form, 'proposedValue'),
    description: text(form, 'description'),
    fieldName: text(form, 'fieldName'),
    files,
  });

  if (result.ok) {
    revalidatePath('/sales/requests');
    revalidatePath('/sales');
  }

  return result;
}

export async function resubmitCorrectionAction(
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole('sales');

  const files = await readFiles(form);
  if ('error' in files) return fail(files.error, { files: [files.error] });

  const requestId = text(form, 'requestId');

  const result = await resubmitCorrection(actor, {
    requestId,
    proposedValue: text(form, 'proposedValue'),
    description: text(form, 'description'),
    files,
  });

  if (result.ok) {
    revalidatePath('/sales/requests');
    revalidatePath(`/sales/requests/${requestId}`);
  }

  return result;
}

export async function withdrawCorrectionAction(
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole('sales');
  const requestId = text(form, 'requestId');

  const result = await withdrawCorrection(actor, {
    requestId,
    reason: text(form, 'reason'),
  });

  if (result.ok) {
    revalidatePath('/sales/requests');
    revalidatePath(`/sales/requests/${requestId}`);
  }

  return result;
}

/**
 * The section 7.2 cross-scope lookup.
 *
 * Gated on `requireRole('sales')` like the rest, even though it is the one
 * action that deliberately reads outside the caller's scope — the exception is
 * granted to sales reps raising mapping claims, not to anyone who can reach the
 * endpoint.
 */
export async function lookupRecordAction(appsNo: string): Promise<ActionResult<LookupOutcome>> {
  const actor = await requireRole('sales');
  return lookupRecordByAppsNo(actor, { appsNo });
}
