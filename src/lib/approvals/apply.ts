import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionEvent,
  correctionRequest,
  manpower,
  salesRecord,
  salesRecordVersion,
} from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import {
  findSalesUserBySmId,
  notifyMany,
  recordLink,
  type NotificationInput,
} from '@/lib/notifications/service';
import { CATEGORY_FIELDS, FIELD_BY_KEY, fieldLabel } from '@/lib/fields';
import {
  hasError,
  normalizeAutopay,
  normalizeMoney,
  normalizeSmId,
  normalizeStatus,
  normalizeString,
} from '@/lib/import/normalize';
import { normalizeDate } from '@/lib/import/dates';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * The approval transaction — spec section 7.3.
 *
 * Every step takes the same `tx`. A notification that survives a rolled-back
 * approval tells the submitter about a change that does not exist, and an audit
 * row that survives one claims something happened that did not; both are worse
 * than no row at all, because they are indistinguishable from the truth when
 * read later.
 */

export type ApprovalErrorCode =
  | 'NOT_FOUND'
  | 'NOT_PENDING'
  | 'RECORD_MISSING'
  | 'UNKNOWN_FIELD'
  | 'INVALID_VALUE';

/**
 * A domain failure, thrown rather than returned.
 *
 * Throwing is what rolls the transaction back — a returned failure would commit
 * whatever the earlier steps already wrote. `actions.ts` catches this at the
 * boundary and turns it into an `ActionResult` for the form.
 */
export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

export type DecisionActor = Pick<SessionUser, 'id' | 'email' | 'role'>;

export type DecisionInput = {
  requestId: string;
  actor: DecisionActor;
  remarks?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type ApprovalOutcome = {
  requestId: string;
  recordId: string;
  appsNo: string;
  fieldName: string;
  fieldLabel: string;
  previousValue: string | null;
  newValue: string | null;
  /** The version row that carries the approved value — the record's new current. */
  appliedVersion: number;
  /**
   * Facts the approver must see afterwards that must not block the decision —
   * an SM_ID missing from the roster, a rep with no portal account. Blocking on
   * these would stall reconciliation behind data the approver cannot fix.
   */
  warnings: string[];
};

export type DecisionOutcome = {
  requestId: string;
  appsNo: string;
  status: 'REJECTED' | 'RETURNED';
};

/* --------------------------------------------------------- field resolution */

/**
 * Picks the record column a request targets from the category, not the text.
 *
 * `category` is a database enum and cannot hold anything outside the four
 * values; `field_name` is free text written by the submitting client. Where the
 * category pins exactly one field (AUTOPAY, MAPPING, ISSUANCE_DATE) the category
 * wins, so a tampered `field_name` cannot redirect an approved AutoPay
 * correction into `anp`. Only OTHERS lets the submitter name the field, and that
 * name is checked against the canonical registry.
 */
function resolveTargetField(category: string, fieldName: string): string {
  const allowed = CATEGORY_FIELDS[category];
  if (!allowed || allowed.length === 0) {
    throw new ApprovalError('UNKNOWN_FIELD', `Category ${category} has no target field.`);
  }
  if (allowed.length === 1) return allowed[0];
  if (!allowed.includes(fieldName)) {
    throw new ApprovalError('UNKNOWN_FIELD', `"${fieldName}" is not a correctable field.`);
  }
  return fieldName;
}

/**
 * Runs the proposed text through the same normalizers the importer uses.
 *
 * A value approved through this path and a value imported from the workbook end
 * up in the same shape — `Yes`/`No` for AutoPay, an uppercase SM_ID, an ISO
 * date, a decimal string for money. Skipping it would let an approval introduce
 * exactly the inconsistencies the import pipeline exists to remove, and the
 * `sales_record_sm_id_uppercase` CHECK would reject the write anyway.
 */
function coerceValue(fieldKey: string, raw: string): string | null {
  const field = FIELD_BY_KEY.get(fieldKey);
  if (!field) throw new ApprovalError('UNKNOWN_FIELD', `Unknown field "${fieldKey}".`);

  const reject = (message: string): never => {
    throw new ApprovalError('INVALID_VALUE', message);
  };

  let value: string | null;

  if (fieldKey === 'smId') {
    value = normalizeSmId(raw).value;
  } else {
    switch (field.kind) {
      case 'money': {
        const result = normalizeMoney(raw, fieldKey);
        if (hasError(result.issues)) reject(result.issues[0].message);
        value = result.value;
        break;
      }
      case 'date': {
        // The proposed value comes from a date input, so it is already ISO.
        const result = normalizeDate(raw, 'yyyy-MM-dd', field.label);
        if (hasError(result.issues)) reject(result.issues[0].message);
        value = result.value;
        break;
      }
      case 'autopay':
        value = normalizeAutopay(raw).value;
        break;
      case 'status':
        value = normalizeStatus(raw).value;
        break;
      default:
        value = normalizeString(raw);
    }
  }

  if (value === null && field.required) {
    reject(`${field.label} cannot be cleared — it identifies the record.`);
  }

  return value;
}

/* ---------------------------------------------------------------- approval */

/** Opens the transaction for callers that are not already inside one. */
export async function applyApproval(input: DecisionInput): Promise<ApprovalOutcome> {
  return db.transaction((tx) => applyApprovalWithin(tx, input));
}

/**
 * The seven steps of spec section 7.3, in order, inside one transaction.
 *
 * Exposed separately from `applyApproval` so a caller that already holds a
 * transaction composes with it rather than nesting a second one — and so the
 * atomicity claim is testable by throwing after the last step and asserting
 * nothing survived.
 */
export async function applyApprovalWithin(
  tx: DbTransaction,
  input: DecisionInput,
): Promise<ApprovalOutcome> {
  const warnings: string[] = [];
  const remarks = input.remarks?.trim() || null;

  /* 1 ── re-read the record FOR UPDATE and re-verify the request is PENDING */

  const [initial] = await tx
    .select({ recordId: correctionRequest.recordId })
    .from(correctionRequest)
    .where(eq(correctionRequest.id, input.requestId))
    .limit(1);

  if (!initial) {
    throw new ApprovalError('NOT_FOUND', 'That correction request no longer exists.');
  }

  // The lock is taken on the record, not the request, because the record is
  // what two concurrent approvals would both rewrite. Whoever gets here second
  // blocks until the first commits and then sees its result, which is the only
  // reason the status re-check below is meaningful rather than a re-read of a
  // stale snapshot.
  const [record] = await tx
    .select()
    .from(salesRecord)
    .where(eq(salesRecord.id, initial.recordId))
    .limit(1)
    .for('update');

  if (!record) {
    throw new ApprovalError('RECORD_MISSING', 'The record this request points at is gone.');
  }

  const [request] = await tx
    .select()
    .from(correctionRequest)
    .where(and(eq(correctionRequest.id, input.requestId), eq(correctionRequest.status, 'PENDING')))
    .limit(1)
    .for('update');

  if (!request) {
    throw new ApprovalError(
      'NOT_PENDING',
      'This request has already been decided by someone else. Reload to see the outcome.',
    );
  }

  const fieldKey = resolveTargetField(request.category, request.fieldName);
  const label = fieldLabel(fieldKey);
  const newValue = coerceValue(fieldKey, request.proposedValue);
  const previousValue = readField(record, fieldKey);

  const isMapping = request.category === 'MAPPING';
  const changedFields = [fieldKey];

  const patch: Record<string, unknown> = {
    [fieldKey]: newValue,
    currentVersion: record.currentVersion + 1,
    hasCorrections: true,
    updatedAt: new Date(),
  };

  let resolvedSmName: string | null = null;

  if (isMapping) {
    // sm_id and sm_name are never allowed to diverge (spec 7.2), so the name is
    // looked up from the roster rather than taken from anything the submitter
    // typed. Seven SM_IDs in the June data have no roster row; for those the
    // name is cleared rather than left pointing at the losing rep, because a
    // stale name is a wrong assertion where a null is an honest "unknown".
    const [roster] = await tx
      .select({ smName: manpower.smName })
      .from(manpower)
      .where(eq(manpower.smId, newValue ?? ''))
      .limit(1);

    resolvedSmName = roster?.smName ?? null;
    if (!roster) {
      warnings.push(
        `${newValue} is not in the Manpower roster, so the rep name was cleared rather than guessed. Ask an admin to add the roster entry.`,
      );
    }

    patch.smName = resolvedSmName;
    changedFields.push('smName');
  }

  /* 2 ── update the record and bump the version */

  const [updated] = await tx
    .update(salesRecord)
    .set(patch as Partial<typeof salesRecord.$inferInsert>)
    .where(eq(salesRecord.id, record.id))
    .returning();

  const appliedVersion = updated.currentVersion;

  /* 3 ── snapshot the record AT its new version */

  // Version N holds the state AT version N, so `current_version` always names a
  // row that exists and "what changed at N" is a diff of N against N-1. The
  // pre-change state is still preserved as a version — it is N-1, written by
  // whatever made the record look that way (v1 by the import, per spec 5.5).
  //
  // Storing the pre-change state here instead would duplicate v1 byte for byte
  // on the first correction and leave the record's actual current state in no
  // version row at all, which is the one state anyone reading the chain most
  // needs to find.
  //
  // The snapshot is the row RETURNING handed back rather than a hand-merged
  // object: a snapshot assembled in JS is a claim about what the table holds,
  // where this is a copy of it.
  await tx.insert(salesRecordVersion).values({
    recordId: record.id,
    version: appliedVersion,
    data: updated as unknown as Record<string, unknown>,
    changeType: 'CORRECTION',
    changedFields,
    changedBy: input.actor.id,
    correctionRequestId: request.id,
    note: `${label}: ${previousValue ?? '(empty)'} → ${newValue ?? '(empty)'}`,
  });

  /* 4 ── mark the request APPROVED */

  const decidedAt = new Date();

  await tx
    .update(correctionRequest)
    .set({
      status: 'APPROVED',
      reviewedBy: input.actor.id,
      reviewedAt: decidedAt,
      approverRemarks: remarks,
      appliedAt: decidedAt,
      appliedVersion,
    })
    .where(eq(correctionRequest.id, request.id));

  /* 5 ── the event that renders the timeline */

  await tx.insert(correctionEvent).values({
    requestId: request.id,
    action: 'APPROVED',
    actorId: input.actor.id,
    fromStatus: 'PENDING',
    toStatus: 'APPROVED',
    remarks,
  });

  /* 6 ── audit, before and after */

  await writeAudit(
    {
      actor: input.actor,
      action: 'CORRECTION_APPROVE',
      entityType: 'correction_request',
      entityId: request.id,
      before: { status: 'PENDING', proposedValue: request.proposedValue },
      after: { status: 'APPROVED', appliedVersion, approverRemarks: remarks },
      metadata: {
        appsNo: request.appsNo,
        category: request.category,
        fieldName: fieldKey,
        submittedBy: request.submittedBy,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  // A second row against the record itself, not a duplicate of the first: the
  // request trail answers "who decided what", the record trail answers "what
  // changed on this policy", and an auditor asking the second question should
  // not have to know a correction request existed.
  await writeAudit(
    {
      actor: input.actor,
      action: 'RECORD_UPDATE',
      entityType: 'sales_record',
      entityId: record.id,
      before: snapshotFields(record, changedFields),
      after: snapshotFields(updated, changedFields),
      metadata: { appsNo: request.appsNo, correctionRequestId: request.id, appliedVersion },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  /* 7 ── notify */

  const notifications = new Map<string, NotificationInput>();

  if (isMapping) {
    const losingSmId = record.smId;
    const gainingSmId = newValue ?? '';

    const [losing, gaining] = await Promise.all([
      findSalesUserBySmId(losingSmId, tx),
      findSalesUserBySmId(gainingSmId, tx),
    ]);

    // The losing rep is notified, not consulted (spec 7.2). Without this the
    // record simply disappears from their list, which is indistinguishable from
    // data loss and generates a support ticket instead of an understood
    // reassignment.
    if (losing && losingSmId !== gainingSmId) {
      notifications.set(losing.id, {
        userId: losing.id,
        type: 'MAPPING_LOST',
        title: `Application ${request.appsNo} was reassigned`,
        body: `An approved mapping claim moved this sale to ${gainingSmId}${
          resolvedSmName ? ` (${resolvedSmName})` : ''
        }. Raise your own mapping claim if you disagree.`,
        link: '/sales/records',
      });
    } else if (!losing && losingSmId !== gainingSmId) {
      warnings.push(`${losingSmId} has no active portal account, so no reassignment notice was sent.`);
    }

    if (gaining) {
      notifications.set(gaining.id, {
        userId: gaining.id,
        type: 'MAPPING_GAINED',
        title: `Application ${request.appsNo} is now yours`,
        body: `An approved mapping claim moved this sale to your SM_ID.`,
        link: recordLink(request.appsNo, 'sales'),
      });
    } else {
      warnings.push(`${gainingSmId} has no active portal account, so no reassignment notice was sent.`);
    }
  }

  // The submitter's decision notice is skipped when a MAPPING_* row already
  // reached them: both link to the same reassignment and the mapping wording is
  // strictly more informative, so sending both is noise, not redundancy.
  if (!notifications.has(request.submittedBy)) {
    notifications.set(request.submittedBy, {
      userId: request.submittedBy,
      type: 'CORRECTION_APPROVED',
      title: `Correction approved — ${request.appsNo}`,
      body: `${label} is now "${newValue ?? '(empty)'}".${remarks ? ` Approver: ${remarks}` : ''}`,
      link: `/sales/requests/${request.id}`,
    });
  }

  await notifyMany([...notifications.values()], tx);

  return {
    requestId: request.id,
    recordId: record.id,
    appsNo: request.appsNo,
    fieldName: fieldKey,
    fieldLabel: label,
    previousValue,
    newValue,
    appliedVersion,
    warnings,
  };
}

/* ------------------------------------------------------- reject and return */

/**
 * Rejects or returns a request.
 *
 * `REJECTED` is terminal. `RETURNED` sends the request back to the submitter
 * with the same row and the same id, so the resubmission lands on one timeline
 * instead of forking a second request that has lost the conversation.
 *
 * No record lock is taken here because no record changes; the request row's own
 * `FOR UPDATE` is enough to stop two approvers from both deciding it.
 */
export async function decideWithin(
  tx: DbTransaction,
  input: DecisionInput & { decision: 'REJECT' | 'RETURN' },
): Promise<DecisionOutcome> {
  const remarks = input.remarks?.trim() || null;
  if (!remarks) {
    throw new ApprovalError(
      'INVALID_VALUE',
      'Remarks are required so the submitter knows what to change.',
    );
  }

  const [request] = await tx
    .select()
    .from(correctionRequest)
    .where(and(eq(correctionRequest.id, input.requestId), eq(correctionRequest.status, 'PENDING')))
    .limit(1)
    .for('update');

  if (!request) {
    const [exists] = await tx
      .select({ status: correctionRequest.status })
      .from(correctionRequest)
      .where(eq(correctionRequest.id, input.requestId))
      .limit(1);

    if (!exists) throw new ApprovalError('NOT_FOUND', 'That correction request no longer exists.');
    throw new ApprovalError(
      'NOT_PENDING',
      `This request is already ${exists.status.toLowerCase()} and cannot be decided again.`,
    );
  }

  const status = input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  const decidedAt = new Date();

  await tx
    .update(correctionRequest)
    .set({
      status,
      reviewedBy: input.actor.id,
      reviewedAt: decidedAt,
      approverRemarks: remarks,
    })
    .where(eq(correctionRequest.id, request.id));

  await tx.insert(correctionEvent).values({
    requestId: request.id,
    action: status,
    actorId: input.actor.id,
    fromStatus: 'PENDING',
    toStatus: status,
    remarks,
  });

  await writeAudit(
    {
      actor: input.actor,
      action: input.decision === 'REJECT' ? 'CORRECTION_REJECT' : 'CORRECTION_RETURN',
      entityType: 'correction_request',
      entityId: request.id,
      before: { status: 'PENDING' },
      after: { status, approverRemarks: remarks },
      metadata: {
        appsNo: request.appsNo,
        category: request.category,
        fieldName: request.fieldName,
        submittedBy: request.submittedBy,
      },
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    },
    tx,
  );

  await notifyMany(
    [
      {
        userId: request.submittedBy,
        type: input.decision === 'REJECT' ? 'CORRECTION_REJECTED' : 'CORRECTION_RETURNED',
        title:
          input.decision === 'REJECT'
            ? `Correction rejected — ${request.appsNo}`
            : `More information needed — ${request.appsNo}`,
        body: remarks,
        link: `/sales/requests/${request.id}`,
      },
    ],
    tx,
  );

  return { requestId: request.id, appsNo: request.appsNo, status };
}

export async function rejectRequest(input: DecisionInput): Promise<DecisionOutcome> {
  return db.transaction((tx) => decideWithin(tx, { ...input, decision: 'REJECT' }));
}

export async function returnRequest(input: DecisionInput): Promise<DecisionOutcome> {
  return db.transaction((tx) => decideWithin(tx, { ...input, decision: 'RETURN' }));
}

/* ---------------------------------------------------------------- preview */

export type TargetPreview = {
  fieldKey: string | null;
  label: string;
  /** What the record holds right now, which is what approval will overwrite. */
  liveValue: string | null;
  /** Non-null when this request could not be applied as it stands. */
  problem: string | null;
};

/**
 * What the decision screen shows before the approver commits.
 *
 * Runs the same resolution and coercion the approval will run, but returns the
 * failure instead of throwing it: an approver should learn that a proposed
 * issuance date is unparseable while reading the request, not by pressing
 * Approve and getting an error back.
 */
export function previewTarget(
  request: Pick<typeof correctionRequest.$inferSelect, 'category' | 'fieldName' | 'proposedValue'>,
  record: typeof salesRecord.$inferSelect,
): TargetPreview {
  try {
    const fieldKey = resolveTargetField(request.category, request.fieldName);
    coerceValue(fieldKey, request.proposedValue);
    return {
      fieldKey,
      label: fieldLabel(fieldKey),
      liveValue: readField(record, fieldKey),
      problem: null,
    };
  } catch (error) {
    if (error instanceof ApprovalError) {
      return { fieldKey: null, label: request.fieldName, liveValue: null, problem: error.message };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ helpers */

type RecordRow = typeof salesRecord.$inferSelect;

/** Reads a canonical field off a record row as display text. */
function readField(record: RecordRow, key: string): string | null {
  const value = (record as unknown as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function snapshotFields(record: RecordRow, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = readField(record, key);
  return out;
}
