import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  manpower,
  salesRecord,
} from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import type { SessionUser } from '@/lib/auth/rbac';
import { fieldLabel } from '@/lib/fields';
import { normalizeIdentifier } from '@/lib/import/normalize';
import { findSalesUserBySmId, notify, notifyActiveVerifiers } from '@/lib/notifications/service';
import { assertPeriodOpen, PeriodClosedError, periodForRecord } from '@/lib/periods/service';
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
  type MappingDirection,
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

/** The period trigger of the 2026-07-28 spec section 4.4, by its RAISE ... USING CONSTRAINT name. */
const PERIOD_CLOSED_CONSTRAINT = 'correction_period_must_be_open';

/**
 * The statuses that hold a field locked against a second competing request.
 *
 * Mirrors the partial unique index in `drizzle/custom/0002_one_open_correction.sql`
 * and must stay in step with it — the index is the guarantee, this is what the
 * error messages and the UI derive from.
 */
export const LOCKING_STATUSES = ['PENDING', 'VERIFIED', 'RETURNED'] as const;

/**
 * The statuses a submitter may still withdraw from — 2026-07-28 spec section 3.3.
 *
 * DELIBERATELY NARROWER than LOCKING_STATUSES. A VERIFIED request locks the
 * field but cannot be withdrawn: a verifier has already spent review effort on
 * it and signed their name to it, and letting the submitter discard that
 * silently turns a completed review into a dead end with no record of why.
 *
 * These were one constant before the verifier gate, when the two sets happened
 * to coincide. Keeping them separate is what stops the next change to either one
 * quietly altering the other.
 */
export const WITHDRAWABLE_STATUSES = ['PENDING', 'RETURNED'] as const;

/** @deprecated Use LOCKING_STATUSES or WITHDRAWABLE_STATUSES — they are no longer the same set. */
export const OPEN_STATUSES = WITHDRAWABLE_STATUSES;

export type SubmitCorrectionInput = {
  category: string;
  /** MAPPING only — which way the sale moves. Ignored on every other category. */
  direction?: string;
  /** An application number, or for a TRANSFER_OUT a policy number — spec 4.1. */
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

export type SubmitOutcome = {
  id: string;
  /**
   * Active verifiers reached. Zero means the request is in a queue nobody is
   * subscribed to — the submit still succeeded, so this is surfaced to the rep
   * as a caveat rather than raised as a failure they cannot fix.
   *
   * Returned by BOTH submit and resubmit. A resubmission re-enters at PENDING
   * into the same verifier queue, so it can go unseen for exactly the same
   * reason; reporting it on one path and not the other would leave a rep who
   * fixed a returned request with no warning at all.
   */
  notified: number;
};

/**
 * Recognises the "somebody already has this field open" collision.
 *
 * Drizzle wraps driver errors, so the code and constraint name that identify
 * the violation sit somewhere down the `cause` chain rather than on the thrown
 * error. Matching on the message text alone would catch any failure at all and
 * report a genuine database fault to the user as "already open".
 */
function matchesConstraint(error: unknown, code: string, constraint: string): boolean {
  let cursor: unknown = error;

  while (cursor && typeof cursor === 'object') {
    const candidate = cursor as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };

    if (candidate.code === code) {
      if (candidate.constraint === constraint) return true;
      if (typeof candidate.message === 'string' && candidate.message.includes(constraint)) {
        return true;
      }
    }

    cursor = candidate.cause;
  }

  return false;
}

function isOpenRequestConflict(error: unknown): boolean {
  return matchesConstraint(error, '23505', OPEN_REQUEST_INDEX);
}

/**
 * The period-closed trigger firing.
 *
 * Reaching this means the period closed between `assertPeriodOpen` below and the
 * INSERT — a real race, since closing happens during the monthly upload, which
 * is exactly when reps are busiest. The trigger is the guarantee; the check
 * above it is the explanation.
 */
function isClosedPeriodConflict(error: unknown): boolean {
  return matchesConstraint(error, '23514', PERIOD_CLOSED_CONSTRAINT);
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

type OwnRecord = typeof salesRecord.$inferSelect;

type ResolveOutcome =
  | { ok: true; record: OwnRecord }
  | { ok: false; reason: 'NOT_FOUND' | 'AMBIGUOUS' };

/**
 * Finds a record in the rep's OWN book by application or policy number —
 * 2026-07-29 spec section 4.1.
 *
 * A rep transferring a sale out already owns it, so this needs none of the
 * section 7.2 lookup apparatus: no restricted projection, no rate limit, no
 * audit row per attempt. The scope predicate is part of every query below, so
 * the widest thing this can return is a record the rep can already read.
 *
 * Application number is tried first because it is unique by constraint. Policy
 * number is neither unique nor NOT NULL, which is why the second arm counts its
 * matches instead of taking `limit(1)`: silently transferring one of several
 * policies sharing a number would move a policy nobody named.
 *
 * A policy number that matches nothing in the rep's own book is reported the
 * same way as one that matches nothing at all, so this cannot be used to probe
 * whether a number exists in someone else's book.
 */
async function resolveOwnRecord(smId: string, identifier: string): Promise<ResolveOutcome> {
  const [byAppsNo] = await db
    .select()
    .from(salesRecord)
    .where(and(eq(salesRecord.appsNo, identifier), eq(salesRecord.smId, smId)))
    .limit(1);

  if (byAppsNo) return { ok: true, record: byAppsNo };

  // Bounded at two: the query exists to distinguish "one" from "more than one",
  // and a rep whose book holds fifty rows under one policy number is asked for
  // the application number just the same as one whose book holds two.
  const byPolicyNo = await db
    .select()
    .from(salesRecord)
    .where(and(eq(salesRecord.policyNo, identifier), eq(salesRecord.smId, smId)))
    .limit(2);

  if (byPolicyNo.length === 1) return { ok: true, record: byPolicyNo[0] };
  if (byPolicyNo.length > 1) return { ok: false, reason: 'AMBIGUOUS' };
  return { ok: false, reason: 'NOT_FOUND' };
}

/**
 * Checks a transfer's destination at SUBMISSION — 2026-07-29 spec section 4.2.
 *
 * The roster check is duplicated at approval time as a warning, and the two are
 * not redundant. Refusing here keeps a request that cannot be applied cleanly
 * out of the verifier's queue entirely; the approval-time warning still covers
 * what this cannot see — a roster row deleted, or its `sm_name` blanked, in the
 * interval between submission and decision.
 */
async function checkTransferTarget(
  targetSmId: string,
  ownSmId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (targetSmId === ownSmId) {
    // Not merely pointless: it would still consume the record's one open-request
    // slot under `correction_one_open_per_field`, blocking a real reassignment.
    return { ok: false, message: 'Choose a different SM ID — that one is yours.' };
  }

  const [roster] = await db
    .select({ smId: manpower.smId })
    .from(manpower)
    .where(eq(manpower.smId, targetSmId))
    .limit(1);

  if (!roster) {
    return {
      ok: false,
      message: `${targetSmId} is not in the Manpower roster, so the sale would be reassigned with no SM name. Check the SM ID.`,
    };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------ submit */

export async function submitCorrection(
  actor: SessionUser,
  input: SubmitCorrectionInput,
): Promise<ActionResult<SubmitOutcome>> {
  const scope = actorScope(actor);
  if (!scope.ok) return fail(scope.message);

  const parsed = correctionSubmitSchema.safeParse({
    category: input.category,
    direction: input.direction,
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

  const direction: MappingDirection | null =
    submission.category === 'MAPPING' ? submission.direction : null;

  const { value: identifier } = normalizeIdentifier(submission.appsNo, 'appsNo');
  if (!identifier) {
    const message =
      direction === 'TRANSFER_OUT'
        ? 'Enter the application or policy number.'
        : 'Enter the application number.';
    return fail(message, { appsNo: [message] });
  }

  /*
   * Two resolution paths, because the two directions start from opposite sides
   * of the scope boundary — 2026-07-29 spec section 4.1.
   *
   * A TRANSFER_OUT is raised by the rep who ALREADY OWNS the record, so it
   * resolves inside their own book and accepts a policy number as well as an
   * application number. Everything else — including a CLAIM_IN, whose whole
   * point is a record in someone else's book — resolves by exact application
   * number across all records, and is then bound by the ownership rules below.
   */
  let record: OwnRecord;

  if (direction === 'TRANSFER_OUT') {
    const resolved = await resolveOwnRecord(scope.smId, identifier);
    if (!resolved.ok) {
      const message =
        resolved.reason === 'AMBIGUOUS'
          ? `More than one record in your book has policy number ${identifier}. Enter the application number instead.`
          : `No record for ${identifier} is in your book.`;
      return fail(message, { appsNo: [message] });
    }
    record = resolved.record;
  } else {
    const [found] = await db
      .select()
      .from(salesRecord)
      .where(eq(salesRecord.appsNo, identifier))
      .limit(1);

    if (!found) {
      return fail(`No record exists for application ${identifier}.`, {
        appsNo: [`No record exists for application ${identifier}.`],
      });
    }
    record = found;
  }

  const appsNo = record.appsNo;

  if (direction === 'CLAIM_IN') {
    // Section 7.2: approval moves the record to the CLAIMANT. Letting a rep
    // name any SM_ID would produce an approval that does something other than
    // what the request said, and would turn the lookup exception into a way to
    // push sales onto other people's books. Taken from the session, never from
    // the form.
    //
    // Pushing a sale onto someone else is now a supported thing to want, but it
    // is TRANSFER_OUT, which starts from a record the rep owns.
    if (submission.proposedValue !== scope.smId) {
      return fail('A mapping claim moves the sale to your own SM ID.', {
        proposedValue: ['A mapping claim moves the sale to your own SM ID.'],
      });
    }
    if (record.smId === scope.smId) {
      return fail(`Application ${appsNo} is already mapped to you.`);
    }
  } else if (direction === 'TRANSFER_OUT') {
    // Ownership was already proved by resolveOwnRecord's scope predicate — a
    // record it returns is in this rep's book by construction. What is left is
    // the destination.
    const target = await checkTransferTarget(submission.proposedValue, scope.smId);
    if (!target.ok) return fail(target.message, { proposedValue: [target.message] });
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

  // The monthly close — 2026-07-28 spec section 4.4. Checked before the files
  // are written to disk, so a refusal leaves nothing to clean up.
  //
  // The record's own period, not the currently open one: a record still sitting
  // in June's cycle is June's work, and the question is whether JUNE is closed.
  // Using the open period instead would let a rep raise July claims against
  // records that were never in July's file.
  const periodId = periodForRecord(record);
  try {
    await assertPeriodOpen(periodId);
  } catch (error) {
    if (error instanceof PeriodClosedError) return fail(error.message);
    throw error;
  }

  // Files are written to disk BEFORE the transaction opens. The alternative
  // leaves the transaction open across filesystem I/O, holding a row lock for as
  // long as 50 MB takes to land. An orphaned file if the insert then fails is
  // harmless and is cleaned up below; a database row pointing at a file that was
  // never written is not.
  const uploads = await storeProofUploads(input.files);
  if (!uploads.ok) return fail(uploads.reason, { files: [uploads.reason] });

  try {
    const outcome = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(correctionRequest)
        .values({
          recordId: record.id,
          appsNo,
          category: submission.category as CorrectionCategory,
          // Null on every category but MAPPING, where it is mandatory — the
          // `correction_direction_iff_mapping` CHECK enforces both halves.
          direction,
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
          periodId,
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

      const notified = await notifyVerifiers(tx, {
        requestId: created.id,
        resubmission: false,
        actorName: actor.name,
        category: submission.category,
        label,
        appsNo,
        originalValue,
        proposedValue: proposed.value as string,
      });

      const counterpartyNotified = direction
        ? await notifyMappingCounterparty(tx, {
            requestId: created.id,
            direction,
            resubmission: false,
            actorName: actor.name,
            appsNo,
            currentSmId: record.smId,
            proposedSmId: proposed.value as string,
          })
        : 0;

      await writeAudit(
        {
          actor,
          action: 'CORRECTION_SUBMIT',
          entityType: 'correction_request',
          entityId: created.id,
          after: {
            appsNo,
            category: submission.category,
            direction,
            fieldName,
            originalValue,
            proposedValue: proposed.value,
          },
          metadata: {
            attachmentCount: uploads.stored.length,
            recordSmId: record.smId,
            periodId,
            // Zero on a mapping request means the rep on the other side has no
            // active portal account, so the first they will hear of the
            // reassignment is the record moving. Normal in this data — seven
            // such SM_IDs in the June file — but only visible if it is recorded.
            counterpartyNotified,
            // Zero means this request landed in a queue nobody is subscribed to.
            // Recorded rather than swallowed: from the rep's side a request with
            // no verifier looks exactly like one that is being worked on, and
            // the only way anyone finds out is if this number is written down.
            verifiersNotified: notified,
          },
        },
        tx,
      );

      return { id: created.id, notified };
    });

    return ok(outcome);
  } catch (error) {
    await deleteStoredProofs(uploads.stored.map((s) => s.relativePath));

    if (isClosedPeriodConflict(error)) {
      // The period closed between the check above and this insert — the monthly
      // upload ran while the rep was filling in the form.
      return fail(
        'That reconciliation period was closed while you were submitting. The record now belongs to a closed month and cannot take new corrections.',
      );
    }

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
): Promise<ActionResult<SubmitOutcome>> {
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
    // From the stored row for the same reason the category is: a resubmission
    // corrects a value, it does not turn a transfer into a claim.
    direction: existing.direction ?? undefined,
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

  /*
   * The destination is re-checked on the way back in, per direction.
   *
   * A returned request is the one place a rep may change the proposed value, so
   * the rule that constrained it at submission has to hold again here — a claim
   * that could be resubmitted naming a third party would be a way around the pin
   * that the submission path refuses.
   */
  if (existing.direction === 'CLAIM_IN' && proposed.value !== scope.smId) {
    return fail('A mapping claim moves the sale to your own SM ID.', {
      proposedValue: ['A mapping claim moves the sale to your own SM ID.'],
    });
  }

  if (existing.direction === 'TRANSFER_OUT') {
    const target = await checkTransferTarget(proposed.value as string, scope.smId);
    if (!target.ok) return fail(target.message, { proposedValue: [target.message] });
  }

  // Read fresh rather than carried on the request row. `correction_request.sm_id`
  // is the SUBMITTER's, and the record's owner can have changed since the request
  // was raised — by an import, or by another correction applied while this one
  // sat in RETURNED. The counterparty notice must name who holds the sale now.
  const currentSmId = existing.direction
    ? (
        await db
          .select({ smId: salesRecord.smId })
          .from(salesRecord)
          .where(eq(salesRecord.id, existing.recordId))
          .limit(1)
      )[0]?.smId ?? null
    : null;

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
    const notified = await db.transaction(async (tx) => {
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
          // The verification columns clear with them. They describe the CURRENT
          // review and there is not one yet; leaving them would show the next
          // verifier their predecessor's sign-off on a value that has since
          // changed. The remarks survive on the RETURNED event either way.
          //
          // periodId is deliberately NOT touched: a resubmission continues the
          // claim raised in that cycle, and re-stamping it would move completed
          // work into a month it was never part of.
          verifiedBy: null,
          verifiedAt: null,
          verifierRemarks: null,
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

      // Back to the verifiers, not the approvers: a resubmitted request returns
      // to PENDING and starts the two stages again from the top. A resubmission
      // that skipped verification would let a rep bypass the gate by getting
      // returned once on purpose.
      const recipients = await notifyVerifiers(tx, {
        requestId: existing.id,
        resubmission: true,
        actorName: actor.name,
        category: existing.category,
        label: existing.fieldLabel,
        appsNo: existing.appsNo,
        originalValue: existing.originalValue,
        proposedValue: proposed.value as string,
      });

      // The counterparty is told again, because what they were told about has
      // changed — a returned request is the one place the proposed value moves,
      // and on a TRANSFER_OUT it can move to a DIFFERENT rep entirely. Notifying
      // only on first submission would leave the original target believing a
      // sale is coming that is now going somewhere else.
      const counterpartyNotified =
        existing.direction && currentSmId
          ? await notifyMappingCounterparty(tx, {
              requestId: existing.id,
              direction: existing.direction,
              resubmission: true,
              actorName: actor.name,
              appsNo: existing.appsNo,
              currentSmId,
              proposedSmId: proposed.value as string,
            })
          : 0;

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
            // Recorded on this path for the same reason as on submit: a
            // resubmission that reached no verifier is indistinguishable, from
            // the rep's side, from one being worked on.
            verifiersNotified: recipients,
            counterpartyNotified,
          },
        },
        tx,
      );

      return recipients;
    });

    return ok({ id: existing.id, notified });
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

  if (!(WITHDRAWABLE_STATUSES as readonly string[]).includes(existing.status)) {
    // Naming VERIFIED explicitly: "only a pending or returned request can be
    // withdrawn" leaves a rep staring at a request that is plainly still open
    // and a button that refuses, with no clue that the reason is a review
    // somebody already completed.
    return fail(
      existing.status === 'VERIFIED'
        ? 'This request has already passed verification and is with an approver. Ask them to reject it if it should not go ahead.'
        : 'Only a pending or returned request can be withdrawn.',
    );
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

/**
 * Announces a new or resubmitted request to the VERIFIERS — 2026-07-28 spec
 * section 3.7.
 *
 * This used to notify approvers. It must not any more: with the gate in place a
 * request in PENDING is not actionable by an approver, so telling them about it
 * would fill their inbox with links to a screen whose only button refuses.
 *
 * Submissions go to EVERY active verifier, not to one assignee. There is no
 * queue ownership in this design — whoever picks it up first reviews it.
 *
 * Returns the recipient count so the caller can react to zero.
 */
async function notifyVerifiers(
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
): Promise<number> {
  const categoryLabel = CATEGORY_LABELS[input.category as CorrectionCategory] ?? input.category;

  return notifyActiveVerifiers(
    {
      type: input.resubmission ? 'CORRECTION_RESUBMITTED' : 'CORRECTION_SUBMITTED',
      title: `${input.resubmission ? 'Resubmitted' : 'New'} ${categoryLabel} correction from ${input.actorName}`,
      body: `${input.label} on application ${input.appsNo}: ${input.originalValue ?? '(blank)'} → ${input.proposedValue}`,
      link: `/verifier/requests/${input.requestId}`,
    },
    tx,
  );
}

/**
 * Tells the OTHER rep that a reassignment has been proposed — 2026-07-29 spec
 * section 6.
 *
 * Until now the counterparty heard nothing until the request was APPROVED, at
 * which point `MAPPING_LOST` / `MAPPING_GAINED` arrived and the record had
 * already moved. That is late by a whole review cycle: the moment the other rep
 * can still usefully say something is while the request is in the queue, not
 * after it has been applied.
 *
 * Which rep is the counterparty follows from the direction, and is why direction
 * is stored rather than inferred:
 *
 *  - `CLAIM_IN`      — the submitter is gaining, so the counterparty is the
 *                      record's CURRENT owner, who stands to lose the sale.
 *  - `TRANSFER_OUT`  — the submitter is losing, so the counterparty is the
 *                      PROPOSED owner, who stands to receive it.
 *
 * Two notification types rather than one because the recipient reads them
 * differently: "someone wants a sale you hold" and "a sale is coming to you"
 * call for different attention. Neither needs a migration — `notification.type`
 * is a text column.
 *
 * Returns the recipient count, which is 0 when the counterparty has no active
 * portal account. That is recorded in the audit metadata rather than raised: an
 * SM_ID with no account is normal in this data (seven such IDs in the June
 * file), and it must not block a reassignment the verifier can still approve.
 */
async function notifyMappingCounterparty(
  tx: DbTransaction,
  input: {
    requestId: string;
    direction: MappingDirection;
    resubmission: boolean;
    actorName: string;
    appsNo: string;
    currentSmId: string;
    proposedSmId: string;
  },
): Promise<number> {
  const counterpartySmId =
    input.direction === 'CLAIM_IN' ? input.currentSmId : input.proposedSmId;

  // A transfer to yourself is refused at submission and a claim on your own
  // record likewise, so this is defence in depth rather than an expected path —
  // but notifying the submitter that they are their own counterparty would be
  // pure noise if either check were ever relaxed.
  if (counterpartySmId === input.currentSmId && counterpartySmId === input.proposedSmId) return 0;

  const counterparty = await findSalesUserBySmId(counterpartySmId, tx);
  if (!counterparty) return 0;

  const prefix = input.resubmission ? 'Updated: ' : '';

  const message =
    input.direction === 'CLAIM_IN'
      ? {
          type: 'MAPPING_CLAIM_RAISED' as const,
          title: `${prefix}${input.actorName} is claiming application ${input.appsNo}`,
          body: `This sale is currently in your book. It is with the verifier now; you will be told if it is approved. Raise your own request if you disagree.`,
        }
      : {
          type: 'MAPPING_TRANSFER_PROPOSED' as const,
          title: `${prefix}${input.actorName} is transferring application ${input.appsNo} to you`,
          body: `This sale is proposed to move into your book. It is with the verifier now; you will be told if it is approved.`,
        };

  await notify({ userId: counterparty.id, link: '/sales/requests', ...message }, tx);

  return 1;
}
