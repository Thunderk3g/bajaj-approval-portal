import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionEvent, correctionRequest, salesRecord } from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import type { SessionUser } from '@/lib/auth/rbac';
import { fieldLabel } from '@/lib/fields';
import { normalizeIdentifier } from '@/lib/import/normalize';
import { notifyActiveApprovers } from '@/lib/notifications/service';
import { type ActionResult, fail, ok, zodFieldErrors } from '@/lib/result';
import {
  MAX_PROOFS_PER_REQUEST,
  deleteStoredProofs,
  storeProofUploads,
  type ProofUpload,
  type StoredProof,
} from '@/lib/storage/files';
import {
  CATEGORY_LABELS,
  type CorrectionCategory,
  correctionSubmitSchema,
  normalizeProposedValue,
  targetFieldFor,
  withdrawSchema,
} from './schemas';

/**
 * Correction submission, resubmission and withdrawal — spec section 7.
 *
 * The actor is passed in rather than read from the session here, so this module
 * stays callable from a test without a request context. That is a testability
 * decision and NOT a relaxation of section 4.1: every entry point in
 * `actions.ts` calls `requireRole('sales')` itself before it reaches any of
 * these functions, and no route reaches them any other way.
 */

/** The partial unique index of section 5.6, by the name Postgres reports. */
const OPEN_REQUEST_INDEX = 'correction_one_open_per_field';

/** The statuses a submitter may still act on — section 7. */
export const OPEN_STATUSES = ['PENDING', 'RETURNED'] as const;

export type SubmitCorrectionInput = {
  category: string;
  appsNo: string;
  proposedValue: string;
  description?: string;
  fieldName?: string;
  files: ProofUpload[];
};

export type ResubmitCorrectionInput = {
  requestId: string;
  proposedValue: string;
  description?: string;
  files?: ProofUpload[];
};

/**
 * Recognises the "somebody already has this field open" collision.
 *
 * Drizzle wraps driver errors, so the code and constraint name that identify
 * the violation sit somewhere down the `cause` chain rather than on the thrown
 * error. Matching on the message text alone would catch any failure at all and
 * report a genuine database fault to the user as "already open".
 */
function isOpenRequestConflict(error: unknown): boolean {
  let cursor: unknown = error;

  while (cursor && typeof cursor === 'object') {
    const candidate = cursor as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    if (candidate.code === '23505') {
      if (candidate.constraint === OPEN_REQUEST_INDEX) return true;
      if (typeof candidate.message === 'string' && candidate.message.includes(OPEN_REQUEST_INDEX)) {
        return true;
      }
    }

    cursor = candidate.cause;
  }

  return false;
}

/** Snapshots the record's value for the targeted field — section 5.5. */
function snapshotOriginal(record: Record<string, unknown>, fieldName: string): string | null {
  const value = record[fieldName];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return text === '' ? null : text;
}

function actorScope(actor: SessionUser): { ok: true; smId: string } | { ok: false; message: string } {
  // Mirrors `scopedRecordCondition`: a sales account with no SM_ID is scoped to
  // nothing, and must fail rather than fall through to an unscoped path.
  if (actor.role !== 'sales' || !actor.smId) {
    return { ok: false, message: 'Only a sales user with an SM ID can raise a correction.' };
  }
  return { ok: true, smId: actor.smId };
}

/* ------------------------------------------------------------------ submit */

export async function submitCorrection(
  actor: SessionUser,
  input: SubmitCorrectionInput,
): Promise<ActionResult<{ id: string }>> {
  const scope = actorScope(actor);
  if (!scope.ok) return fail(scope.message);

  const parsed = correctionSubmitSchema.safeParse({
    category: input.category,
    appsNo: input.appsNo,
    proposedValue: input.proposedValue,
    description: input.description,
    fieldName: input.fieldName,
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const submission = parsed.data;
  const fieldName = targetFieldFor(submission);
  const label = fieldLabel(fieldName);

  const { value: appsNo } = normalizeIdentifier(submission.appsNo, 'appsNo');
  if (!appsNo) return fail('Enter the application number.', { appsNo: ['Enter the application number.'] });

  const [record] = await db
    .select()
    .from(salesRecord)
    .where(eq(salesRecord.appsNo, appsNo))
    .limit(1);

  if (!record) {
    return fail(`No record exists for application ${appsNo}.`, {
      appsNo: [`No record exists for application ${appsNo}.`],
    });
  }

  if (submission.category === 'MAPPING') {
    // Section 7.2: approval moves the record to the CLAIMANT. Letting a rep
    // name any SM_ID would produce an approval that does something other than
    // what the request said, and would turn the lookup exception into a way to
    // push sales onto other people's books. Taken from the session, never from
    // the form.
    if (submission.proposedValue !== scope.smId) {
      return fail('A mapping claim moves the sale to your own SM ID.', {
        proposedValue: ['A mapping claim moves the sale to your own SM ID.'],
      });
    }
    if (record.smId === scope.smId) {
      return fail(`Application ${appsNo} is already mapped to you.`);
    }
  } else if (record.smId !== scope.smId) {
    // The section 7.2 exception is for MAPPING only. Every other category is
    // still bound by scope, so a rep cannot change a field on a record they do
    // not own by looking up its application number first.
    return fail(`No record for application ${appsNo} is in your book.`, {
      appsNo: [`No record for application ${appsNo} is in your book.`],
    });
  }

  const proposed = normalizeProposedValue(fieldName, submission.proposedValue);
  if (proposed.value === null || proposed.issues.some((i) => i.severity === 'ERROR')) {
    const message = proposed.issues.find((i) => i.severity === 'ERROR')?.message ?? `Enter a valid ${label}.`;
    return fail(message, { proposedValue: [message] });
  }

  const originalValue = snapshotOriginal(record, fieldName);
  if (originalValue === proposed.value) {
    return fail(`${label} already holds that value.`, {
      proposedValue: [`${label} already holds that value.`],
    });
  }

  // Files are written to disk BEFORE the transaction opens. The alternative
  // leaves the transaction open across filesystem I/O, holding a row lock for as
  // long as 50 MB takes to land. An orphaned file if the insert then fails is
  // harmless and is cleaned up below; a database row pointing at a file that was
  // never written is not.
  const uploads = await storeProofUploads(input.files);
  if (!uploads.ok) return fail(uploads.reason, { files: [uploads.reason] });

  try {
    const id = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(correctionRequest)
        .values({
          recordId: record.id,
          appsNo,
          category: submission.category as CorrectionCategory,
          fieldName,
          fieldLabel: label,
          originalValue,
          proposedValue: proposed.value as string,
          description: submission.description,
          submittedBy: actor.id,
          // The claimant's SM_ID, not the record's. For a mapping claim those
          // differ, and "whose request is this" is the question this column is
          // indexed to answer.
          smId: scope.smId,
          status: 'PENDING',
        })
        .returning({ id: correctionRequest.id });

      await insertAttachments(tx, actor, created.id, uploads.stored);

      await tx.insert(correctionEvent).values({
        requestId: created.id,
        action: 'SUBMITTED',
        actorId: actor.id,
        fromStatus: null,
        toStatus: 'PENDING',
        remarks: submission.description,
      });

      await writeAudit(
        {
          actor,
          action: 'CORRECTION_SUBMIT',
          entityType: 'correction_request',
          entityId: created.id,
          after: {
            appsNo,
            category: submission.category,
            fieldName,
            originalValue,
            proposedValue: proposed.value,
          },
          metadata: { attachmentCount: uploads.stored.length, recordSmId: record.smId },
        },
        tx,
      );

      await notifyApprovers(tx, {
        requestId: created.id,
        resubmission: false,
        actorName: actor.name,
        category: submission.category,
        label,
        appsNo,
        originalValue,
        proposedValue: proposed.value as string,
      });

      return created.id;
    });

    return ok({ id });
  } catch (error) {
    await deleteStoredProofs(uploads.stored.map((s) => s.relativePath));

    if (isOpenRequestConflict(error)) {
      // The database is the authority on this, not a prior SELECT: two reps
      // submitting the same claim milliseconds apart both pass a check-then-act
      // read. Catching the violation is what turns a 500 into an answer.
      return fail(
        `${label} on application ${appsNo} already has an open correction request. Wait for it to be reviewed, or withdraw it first.`,
      );
    }

    throw error;
  }
}

/* --------------------------------------------------------------- resubmit */

export async function resubmitCorrection(
  actor: SessionUser,
  input: ResubmitCorrectionInput,
): Promise<ActionResult<{ id: string }>> {
  const scope = actorScope(actor);
  if (!scope.ok) return fail(scope.message);

  const existing = await loadOwnRequest(actor, input.requestId);
  if (!existing) return fail('That request does not exist.');

  if (existing.status !== 'RETURNED') {
    return fail('Only a returned request can be resubmitted.');
  }

  // Re-parsed through the same union as a first submission. The category and
  // target field come from the stored row rather than the form, so a resubmit
  // cannot quietly become a different correction — but the rules that applied at
  // submission (Yes/No for AutoPay, a description for Others) apply again,
  // rather than being skipped on the way back in.
  const parsed = correctionSubmitSchema.safeParse({
    category: existing.category,
    appsNo: existing.appsNo,
    proposedValue: input.proposedValue,
    description: input.description,
    fieldName: existing.fieldName,
  });

  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const submission = parsed.data;
  const proposed = normalizeProposedValue(existing.fieldName, submission.proposedValue);
  if (proposed.value === null || proposed.issues.some((i) => i.severity === 'ERROR')) {
    const message =
      proposed.issues.find((i) => i.severity === 'ERROR')?.message ??
      `Enter a valid ${existing.fieldLabel}.`;
    return fail(message, { proposedValue: [message] });
  }

  if (existing.category === 'MAPPING' && proposed.value !== scope.smId) {
    return fail('A mapping claim moves the sale to your own SM ID.', {
      proposedValue: ['A mapping claim moves the sale to your own SM ID.'],
    });
  }

  const newFiles = input.files ?? [];
  let uploaded: StoredProof[] = [];

  if (newFiles.length > 0) {
    const existingCount = await countAttachments(existing.id);
    if (existingCount + newFiles.length > MAX_PROOFS_PER_REQUEST) {
      const room = Math.max(0, MAX_PROOFS_PER_REQUEST - existingCount);
      return fail(
        `This request already has ${existingCount} proof document${existingCount === 1 ? '' : 's'}; you can add ${room} more.`,
        { files: ['Too many proof documents.'] },
      );
    }

    const stored = await storeProofUploads(newFiles);
    if (!stored.ok) return fail(stored.reason, { files: [stored.reason] });
    uploaded = stored.stored;
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(correctionRequest)
        .set({
          status: 'PENDING',
          proposedValue: proposed.value as string,
          description: submission.description,
          resubmissionCount: existing.resubmissionCount + 1,
          lastResubmittedAt: new Date(),
          // Cleared because the row's review columns describe the CURRENT
          // review, and there is not one yet. The approver's return remarks are
          // not lost — they live on the RETURNED event, which is why section 5.8
          // keeps a timeline instead of a single status field.
          reviewedBy: null,
          reviewedAt: null,
          approverRemarks: null,
        })
        .where(eq(correctionRequest.id, existing.id));

      if (uploaded.length > 0) {
        await insertAttachments(tx, actor, existing.id, uploaded);
      }

      await tx.insert(correctionEvent).values({
        requestId: existing.id,
        action: 'RESUBMITTED',
        actorId: actor.id,
        fromStatus: 'RETURNED',
        toStatus: 'PENDING',
        remarks: submission.description,
      });

      await writeAudit(
        {
          actor,
          action: 'CORRECTION_RESUBMIT',
          entityType: 'correction_request',
          entityId: existing.id,
          before: { status: existing.status, proposedValue: existing.proposedValue },
          after: { status: 'PENDING', proposedValue: proposed.value },
          metadata: {
            appsNo: existing.appsNo,
            resubmissionCount: existing.resubmissionCount + 1,
            attachmentsAdded: uploaded.length,
          },
        },
        tx,
      );

      await notifyApprovers(tx, {
        requestId: existing.id,
        resubmission: true,
        actorName: actor.name,
        category: existing.category,
        label: existing.fieldLabel,
        appsNo: existing.appsNo,
        originalValue: existing.originalValue,
        proposedValue: proposed.value as string,
      });
    });

    return ok({ id: existing.id });
  } catch (error) {
    await deleteStoredProofs(uploaded.map((s) => s.relativePath));

    if (isOpenRequestConflict(error)) {
      return fail(
        `${existing.fieldLabel} on application ${existing.appsNo} already has another open request.`,
      );
    }

    throw error;
  }
}

/* --------------------------------------------------------------- withdraw */

export async function withdrawCorrection(
  actor: SessionUser,
  input: { requestId: string; reason?: string },
): Promise<ActionResult<{ id: string }>> {
  const parsed = withdrawSchema.safeParse(input);
  if (!parsed.success) return fail('That request does not exist.');

  const existing = await loadOwnRequest(actor, parsed.data.requestId);
  if (!existing) return fail('That request does not exist.');

  if (!(OPEN_STATUSES as readonly string[]).includes(existing.status)) {
    return fail('Only a pending or returned request can be withdrawn.');
  }

  const reason = parsed.data.reason?.trim() || null;

  await db.transaction(async (tx) => {
    await tx
      .update(correctionRequest)
      .set({
        // The request MUST leave PENDING/RETURNED: the partial unique index of
        // section 5.6 keeps the field locked while it sits in either, so an
        // abandoned request would block the rep from ever raising a correct one.
        //
        // reviewedBy / reviewedAt / approverRemarks stay NULL deliberately. No
        // approver reviewed this — the submitter closed it — and filling those
        // columns would put the rep's own id in the "who decided" field, which
        // the approver history and the export's decision column both read.
        // The reason lives on the WITHDRAWN event, where the timeline shows it.
        status: 'WITHDRAWN',
      })
      .where(eq(correctionRequest.id, existing.id));

    await tx.insert(correctionEvent).values({
      requestId: existing.id,
      action: 'WITHDRAWN',
      actorId: actor.id,
      fromStatus: existing.status,
      toStatus: 'WITHDRAWN',
      remarks: reason,
    });

    await writeAudit(
      {
        actor,
        action: 'CORRECTION_WITHDRAW',
        entityType: 'correction_request',
        entityId: existing.id,
        before: { status: existing.status },
        after: { status: 'WITHDRAWN' },
        metadata: { appsNo: existing.appsNo, fieldName: existing.fieldName, reason },
      },
      tx,
    );
  });

  return ok({ id: existing.id });
}

/* ---------------------------------------------------------------- helpers */

/**
 * Loads a request the actor actually submitted.
 *
 * Ownership is a predicate in the query, not a comparison after the read. A
 * request id is guessable in the sense that it appears in URLs and in
 * notifications, so "load then check" leaves a window in which the row has
 * already been fetched — and the difference between "does not exist" and "is not
 * yours" is exactly what an attacker probes for.
 */
async function loadOwnRequest(actor: SessionUser, requestId: string) {
  if (!/^[0-9a-fA-F-]{36}$/.test(requestId)) return null;

  const [row] = await db
    .select()
    .from(correctionRequest)
    .where(and(eq(correctionRequest.id, requestId), eq(correctionRequest.submittedBy, actor.id)))
    .limit(1);

  return row ?? null;
}

async function countAttachments(requestId: string): Promise<number> {
  const rows = await db
    .select({ id: correctionAttachment.id })
    .from(correctionAttachment)
    .where(eq(correctionAttachment.requestId, requestId));
  return rows.length;
}

async function insertAttachments(
  tx: DbTransaction,
  actor: SessionUser,
  requestId: string,
  stored: StoredProof[],
): Promise<void> {
  const rows = await tx
    .insert(correctionAttachment)
    .values(
      stored.map((file) => ({
        requestId,
        storedPath: file.relativePath,
        originalName: file.originalName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        uploadedBy: actor.id,
      })),
    )
    .returning({ id: correctionAttachment.id });

  for (const [index, row] of rows.entries()) {
    const file = stored[index];
    await writeAudit(
      {
        actor,
        action: 'ATTACHMENT_UPLOAD',
        entityType: 'correction_attachment',
        entityId: row.id,
        after: {
          originalName: file.originalName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
        },
        metadata: { requestId },
      },
      tx,
    );
  }
}

async function notifyApprovers(
  tx: DbTransaction,
  input: {
    requestId: string;
    resubmission: boolean;
    actorName: string;
    category: string;
    label: string;
    appsNo: string;
    originalValue: string | null;
    proposedValue: string;
  },
): Promise<void> {
  const categoryLabel = CATEGORY_LABELS[input.category as CorrectionCategory] ?? input.category;

  // Section 10, row 1: submissions and resubmissions go to EVERY active
  // approver, not to one assignee. There is no queue ownership in this design —
  // whoever picks it up first reviews it.
  await notifyActiveApprovers(
    {
      type: input.resubmission ? 'CORRECTION_RESUBMITTED' : 'CORRECTION_SUBMITTED',
      title: `${input.resubmission ? 'Resubmitted' : 'New'} ${categoryLabel} correction from ${input.actorName}`,
      body: `${input.label} on application ${input.appsNo}: ${input.originalValue ?? '(blank)'} → ${input.proposedValue}`,
      link: `/approver/requests/${input.requestId}`,
    },
    tx,
  );
}
