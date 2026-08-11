import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  manpower,
  salesRecord,
} from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import { teamSmIds, type SessionUser } from '@/lib/auth/rbac';
import { fieldLabel } from '@/lib/fields';
import { normalizeIdentifier } from '@/lib/import/normalize';
import { isPlaceholderCode, PLACEHOLDER_REASON } from '@/lib/roster/placeholders';
import { findSalesUserBySmId, notify, requestLink } from '@/lib/notifications/service';
import {
  chainKeyFor,
  closeActiveStage,
  counterpartySmIdFor,
  materializeStages,
  resetStages,
} from '@/lib/workflows';
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

/**
 * The books this actor may raise a request against — 2026-08-06 spec section 5.
 *
 * A rep has one: their own. A team leader has their team's, an area manager
 * their cluster's, because a manager is answerable for their people's data and
 * was previously reduced to telling a rep what to type. The set is the same one
 * `scopedRecordCondition` reads them by, so a manager can raise a request on
 * exactly the records they can already see, and on no others.
 *
 * Materialised rather than left as a subquery: the same list fills the rep
 * picker on the manager's form, and a membership test against a few hundred
 * codes in memory is cheaper than a round trip per check.
 *
 * `own` separates the two cases where being the rep matters. A mapping claim
 * moves the sale to somebody, and for a rep that somebody is always themselves;
 * a manager has to name which of their people it lands on.
 */
export type ActorBooks = {
  /** Every SM_ID this actor may act for. */
  smIds: string[];
  /** The actor's own SM_ID when they are a rep, null when they are a manager. */
  own: string | null;
  /** "your book" or "your team", for messages that name the boundary. */
  noun: string;
};

export async function actorBooks(
  actor: SessionUser,
): Promise<{ ok: true; books: ActorBooks } | { ok: false; message: string }> {
  if (actor.role === 'sales') {
    // Mirrors `scopedRecordCondition`: a sales account with no SM_ID is scoped
    // to nothing, and must fail rather than fall through to an unscoped path.
    if (!actor.smId) {
      return { ok: false, message: 'Only a sales user with an SM ID can raise a correction.' };
    }
    return { ok: true, books: { smIds: [actor.smId], own: actor.smId, noun: 'your book' } };
  }

  if (actor.role === 'tl' || actor.role === 'acm') {
    const code = actor.role === 'tl' ? actor.tlCode : actor.acmCode;
    const rung = actor.role === 'tl' ? 'team leader' : 'area manager';
    if (!code) {
      return { ok: false, message: `This ${rung} account has no code, so it manages nobody.` };
    }

    // The same predicate the read scope uses, so "raise for" can never widen
    // beyond "can see" — one function, one definition of a team.
    const rows = await db
      .select({ smId: manpower.smId })
      .from(manpower)
      .where(sql`${manpower.smId} in ${teamSmIds(actor.role === 'tl' ? 'tl_id' : 'ccm_id', code)}`);

    if (rows.length === 0) {
      return {
        ok: false,
        message: `The Manpower roster places nobody under ${code}, so there is no book to raise a request against.`,
      };
    }

    return { ok: true, books: { smIds: rows.map((r) => r.smId), own: null, noun: 'your team' } };
  }

  return {
    ok: false,
    message: 'Only a sales user, or their team leader or area manager, can raise a correction.',
  };
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
async function resolveOwnRecord(smIds: string[], identifier: string): Promise<ResolveOutcome> {
  const [byAppsNo] = await db
    .select()
    .from(salesRecord)
    .where(and(eq(salesRecord.appsNo, identifier), inArray(salesRecord.smId, smIds)))
    .limit(1);

  if (byAppsNo) return { ok: true, record: byAppsNo };

  // Bounded at two: the query exists to distinguish "one" from "more than one",
  // and a rep whose book holds fifty rows under one policy number is asked for
  // the application number just the same as one whose book holds two.
  const byPolicyNo = await db
    .select()
    .from(salesRecord)
    .where(and(eq(salesRecord.policyNo, identifier), inArray(salesRecord.smId, smIds)))
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
  currentSmId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (targetSmId === currentSmId) {
    // Not merely pointless: it would still consume the record's one open-request
    // slot under `correction_one_open_per_field`, blocking a real reassignment.
    return {
      ok: false,
      message: `Choose a different SM ID — the sale is already mapped to ${currentSmId}.`,
    };
  }

  // Before the roster is consulted, because the roster answers yes: the sheet
  // carries a row for each bucket. A transfer INTO `DIY` would take a sale off a
  // named rep and park it in the digital channel, which is the one direction the
  // mapping flow exists to undo.
  if (isPlaceholderCode(targetSmId)) {
    return {
      ok: false,
      message: `${targetSmId} is ${PLACEHOLDER_REASON}. A sale cannot be transferred to it.`,
    };
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
  const scope = await actorBooks(actor);
  if (!scope.ok) return fail(scope.message);
  const books = scope.books;

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
    const resolved = await resolveOwnRecord(books.smIds, identifier);
    if (!resolved.ok) {
      const message =
        resolved.reason === 'AMBIGUOUS'
          ? `More than one record in ${books.noun} has policy number ${identifier}. Enter the application number instead.`
          : `No record for ${identifier} is in ${books.noun}.`;
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

  /**
   * Whose book the request belongs to.
   *
   * A claim names its destination, so the claimant is the proposed SM_ID; every
   * other category is about the record where it already sits. For a rep the two
   * collapse to their own SM_ID, which is what this used to read off the
   * session. A manager raising for one of their people is the reason it is
   * derived rather than assumed: the request belongs to the REP's book, and the
   * chain, the queue and the counterparty notice all key on that.
   */
  const bookSmId = direction === 'CLAIM_IN' ? submission.proposedValue : record.smId;

  if (direction === 'CLAIM_IN') {
    // Section 7.2: approval moves the record to the CLAIMANT, so the destination
    // must be somebody this actor may act for — themselves, for a rep. Letting
    // anyone name any SM_ID would produce an approval that does something other
    // than what the request said, and would turn the lookup exception into a way
    // to push sales onto other people's books.
    //
    // Pushing a sale onto someone outside that boundary is a supported thing to
    // want, but it is TRANSFER_OUT, which starts from a record already inside it.
    if (!books.smIds.includes(bookSmId)) {
      const message = books.own
        ? 'A mapping claim moves the sale to your own SM ID.'
        : `A mapping claim moves the sale to one of your reps. ${submission.proposedValue || 'That SM ID'} is not in ${books.noun}.`;
      return fail(message, { proposedValue: [message] });
    }
    if (record.smId === bookSmId) {
      return fail(
        books.own
          ? `Application ${appsNo} is already mapped to you.`
          : `Application ${appsNo} is already mapped to ${bookSmId}.`,
      );
    }
  } else if (direction === 'TRANSFER_OUT') {
    // Ownership was already proved by resolveOwnRecord's scope predicate — a
    // record it returns is inside this actor's boundary by construction. What is
    // left is the destination, which must differ from where the sale sits now.
    const target = await checkTransferTarget(submission.proposedValue, record.smId);
    if (!target.ok) return fail(target.message, { proposedValue: [target.message] });
  } else if (!books.smIds.includes(record.smId)) {
    // The section 7.2 exception is for MAPPING only. Every other category is
    // still bound by scope, so nobody can change a field on a record outside
    // their boundary by looking up its application number first.
    return fail(`No record for application ${appsNo} is in ${books.noun}.`, {
      appsNo: [`No record for application ${appsNo} is in ${books.noun}.`],
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
          // indexed to answer. It is the REP's code even when a manager raised
          // it — the request belongs to the book it is about, and `submittedBy`
          // above is what records who actually raised it.
          smId: bookSmId,
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

      /**
       * The chain replaces the fixed "tell every verifier" — 2026-08-06 spec §4.
       *
       * `counterpartySmId` is written first because the chain is CHOSEN by it: a
       * mapping request whose other side sits under a different TL runs the
       * between-teams chain, and that question cannot be re-asked later once an
       * approval has rewritten `record.sm_id`.
       *
       * `materializeStages` opens the first rung, resolves who it belongs to,
       * pins them and notifies them — so this one call does what `notifyVerifiers`
       * used to, and does it for a TL or an ACM just as readily.
       */
      const counterpartySmId = counterpartySmIdFor({
        direction,
        recordSmId: record.smId,
        proposedSmId: proposed.value as string,
      });

      if (counterpartySmId) {
        await tx
          .update(correctionRequest)
          .set({ counterpartySmId })
          .where(eq(correctionRequest.id, created.id));
      }

      const chainKey = await chainKeyFor(tx, {
        category: submission.category,
        direction,
        submitterSmId: bookSmId,
        counterpartySmId,
      });

      const opened = await materializeStages(tx, created.id, chainKey, {
        actorName: actor.name,
        resubmission: false,
      });
      const notified = opened.notified;

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

      const bookOwnerNotified = await notifyBookOwner(tx, {
        requestId: created.id,
        smId: bookSmId,
        submittedBy: actor.id,
        actorName: actor.name,
        appsNo,
        fieldLabel: label,
        originalValue,
        proposedValue: proposed.value as string,
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
            // 1 when a manager raised this for one of their reps and that rep
            // has a login; 0 when the rep raised it themselves, or has none.
            bookOwnerNotified,
            // Zero means this request landed in a queue nobody is subscribed to.
            // Recorded rather than swallowed: from the rep's side a request with
            // no verifier looks exactly like one that is being worked on, and
            // the only way anyone finds out is if this number is written down.
            verifiersNotified: notified,
            chainKey,
            counterpartySmId,
            // A rung that resolved to nobody, or to nobody with an account. The
            // request still moves — see `openStage` — but the gap is recorded
            // here so it is answerable later without re-deriving the roster as it
            // stood at submission.
            routingWarnings: opened.warnings,
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
  // Whoever raised it may resubmit it — `loadOwnRequest` below pins the request
  // to this actor, so a manager can answer a return on a request they raised
  // and a rep cannot touch one they did not.
  const scope = await actorBooks(actor);
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
  // Against the request's OWN book rather than the actor's, which is the same
  // value for a rep and the right one for a manager: a claim raised for one of
  // their reps must come back for that same rep, not be redirected to another on
  // the way through a return.
  if (existing.direction === 'CLAIM_IN' && proposed.value !== existing.smId) {
    const message =
      scope.books.own === existing.smId
        ? 'A mapping claim moves the sale to your own SM ID.'
        : `This claim was raised for ${existing.smId}. Withdraw it and raise a new one to claim for somebody else.`;
    return fail(message, { proposedValue: [message] });
  }

  if (existing.direction === 'TRANSFER_OUT') {
    const target = await checkTransferTarget(proposed.value as string, existing.smId);
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

      // Back to the top of the chain, not to whichever rung sent it back: a
      // resubmitted request starts its stages again from the first. A
      // resubmission that resumed mid-chain would let a rep bypass every gate
      // below the one that returned it by getting returned once on purpose.
      //
      // `resetStages` walks the request's OWN frozen stages, so a chain an admin
      // has edited in the meantime does not lengthen the ladder underneath
      // somebody who is halfway up it.
      const reopened = await resetStages(tx, existing.id, {
        actorName: actor.name,
        resubmission: true,
      });
      const recipients = reopened.notified;

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

    // The open rung is closed with it. A stage left ACTIVE on a withdrawn request
    // would keep the request in somebody's queue for a decision that can no
    // longer be made, and would occupy the partial unique index slot that says
    // "this request has a rung in progress".
    await closeActiveStage(tx, existing.id, 'WITHDRAWN');

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
 * Tells a rep that their manager raised a correction against their book —
 * `docs/ui-flows.md` §7.
 *
 * Until this existed a TL-raised request was invisible to the rep it was about:
 * `openStage` notifies the first rung, `notifyMappingCounterparty` notifies the
 * other side of a mapping claim, and neither is the rep whose book it is. The
 * request then showed up as pending in the manager's bucket alone, which is the
 * bug reported.
 *
 * Returns 0 and does nothing when the raiser IS the rep, and when the SM_ID has
 * no active account. The second case is a warning condition everywhere else in
 * this codebase and never a blocker — an SM_ID without a login is normal in this
 * data, and refusing the submission over it would stop a manager doing the job
 * this feature exists for.
 */
async function notifyBookOwner(
  tx: DbTransaction,
  input: {
    requestId: string;
    smId: string;
    submittedBy: string;
    actorName: string;
    appsNo: string;
    fieldLabel: string;
    originalValue: string | null;
    proposedValue: string;
  },
): Promise<number> {
  const owner = await findSalesUserBySmId(input.smId, tx);
  if (!owner || owner.id === input.submittedBy) return 0;

  await notify(
    {
      userId: owner.id,
      type: 'CORRECTION_RAISED_FOR_YOU',
      title: `${input.actorName} raised a correction on your book — ${input.appsNo}`,
      body: `${input.fieldLabel}: ${input.originalValue ?? '(blank)'} → ${input.proposedValue}. You can follow it, but only ${input.actorName} can resubmit or withdraw it.`,
      link: requestLink(input.requestId, 'sales'),
    },
    tx,
  );

  return 1;
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
