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

/**
 * Who may raise, and for whom — 2026-08-06 spec section 5.
 *
 * A rep raises for their own book; a team leader and an area manager raise for
 * the people beneath them, which is the same boundary they already read and
 * approve across. The service decides WHOSE book each request lands in
 * (`actorBooks`); this list only decides who may reach it at all.
 */
const RAISING_ROLES = ['sales', 'tl', 'acm'] as const;

/**
 * Every list a raise, a resubmit or a withdrawal can change.
 *
 * `RAISING_ROLES` above is the reason there is more than one: a team leader and
 * an area manager raise for their people, and "Requests I raised" is their copy
 * of the rep's list. Revalidating only `/sales/*`, as this did, left a manager
 * looking at a cached list that did not contain the request they had just
 * raised — which reads as the raise having failed. `decide-action.ts`
 * revalidates both sides for the same reason.
 */
const RAISER_LIST_PATHS = ['/sales/requests', '/tl/requests', '/acm/requests'] as const;

export async function submitCorrectionAction(
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(...RAISING_ROLES);

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
    for (const path of RAISER_LIST_PATHS) revalidatePath(path);
    revalidatePath('/sales');
  }

  return result;
}

export async function resubmitCorrectionAction(
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(...RAISING_ROLES);

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
    for (const path of RAISER_LIST_PATHS) {
      revalidatePath(path);
      revalidatePath(`${path}/${requestId}`);
    }
  }

  return result;
}

export async function withdrawCorrectionAction(
  form: FormData,
): Promise<ActionResult<{ id: string }>> {
  const actor = await requireRole(...RAISING_ROLES);
  const requestId = text(form, 'requestId');

  const result = await withdrawCorrection(actor, {
    requestId,
    reason: text(form, 'reason'),
  });

  if (result.ok) {
    for (const path of RAISER_LIST_PATHS) {
      revalidatePath(path);
      revalidatePath(`${path}/${requestId}`);
    }
  }

  return result;
}

/**
 * The section 7.2 cross-scope lookup.
 *
 * Gated on the raising roles like the rest, even though it is the one action
 * that deliberately reads outside the caller's scope — the exception is granted
 * to whoever may raise a mapping claim, not to anyone who can reach the
 * endpoint. A manager raising a claim for one of their reps needs the same six
 * columns, under the same rate limit and the same audit row per attempt.
 */
export async function lookupRecordAction(appsNo: string): Promise<ActionResult<LookupOutcome>> {
  const actor = await requireRole(...RAISING_ROLES);
  return lookupRecordByAppsNo(actor, { appsNo });
}
