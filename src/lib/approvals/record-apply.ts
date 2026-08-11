import { and, eq } from 'drizzle-orm';
import {
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
  requestRecipients,
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
 * Everything that changes the RECORD when a correction is finally approved.
 *
 * Lives below both callers rather than inside either. The two-stage flow in
 * `apply.ts` and the N-stage engine in `lib/workflows/engine.ts` both finish a
 * request, and both must write the customer record identically; putting the
 * shared body in one of them and importing it from the other would make the
 * dependency a cycle, and duplicating it would make "identically" a thing
 * somebody maintains rather than a thing the compiler enforces.
 */

export type ApprovalErrorCode =
  | 'NOT_FOUND'
  /**
   * Kept under its original name after the 2026-07-28 gate change, though the
   * status it now demands is VERIFIED. Renaming it would touch every call site
   * and every test for no behavioural gain; the message says which status was
   * expected, and this code only ever means "the row is not in the state this
   * transition starts from".
   */
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

export type RecordRow = typeof salesRecord.$inferSelect;

/* --------------------------------------------------------- field resolution */

/**
 * Picks the record column a request targets from the category, not the text.
 *
 * `category` is a database enum and cannot hold anything outside its values;
 * `field_name` is free text written by the submitting client. Where the category
 * pins exactly one field (AUTOPAY, MAPPING, ISSUANCE_DATE, AGENT_ID, BAU_TO_BFL)
 * the category wins, so a tampered `field_name` cannot redirect an approved
 * AutoPay correction into `anp`. Only OTHERS lets the submitter name the field,
 * and that name is checked against the canonical registry.
 */
export function resolveTargetField(category: string, fieldName: string): string {
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
export function coerceValue(fieldKey: string, raw: string): string | null {
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

/** Reads a canonical field off a record row as display text. */
export function readField(record: RecordRow, key: string): string | null {
  const value = (record as unknown as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export function snapshotFields(record: RecordRow, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = readField(record, key);
  return out;
}

/* ------------------------------------------------- applying to the record */

export type RecordApplication = {
  recordId: string;
  fieldKey: string;
  label: string;
  previousValue: string | null;
  newValue: string | null;
  appliedVersion: number;
  warnings: string[];
  /**
   * Recipients the reassignment itself implies, keyed by user id so the caller
   * can decide whether its own decision notice would be a duplicate.
   */
  notifications: Map<string, NotificationInput>;
};

type ApplicableRequest = Pick<
  typeof correctionRequest.$inferSelect,
  'id' | 'appsNo' | 'category' | 'direction' | 'fieldName' | 'proposedValue' | 'submittedBy'
>;

/**
 * Steps 2, 3, part of 6 and part of 7 of spec section 7.3 — everything that
 * changes the RECORD, and nothing that changes the request.
 *
 * The record MUST already be locked `FOR UPDATE` by the caller: this reads
 * `currentVersion` and writes `currentVersion + 1`, which is a lost update the
 * moment two approvals interleave. The caller holds the lock because the caller
 * also decides what else the lock has to cover.
 */
export async function applyCorrectionToRecord(
  tx: DbTransaction,
  request: ApplicableRequest,
  record: RecordRow,
  actor: DecisionActor,
  audit: { ipAddress?: string | null; userAgent?: string | null },
): Promise<RecordApplication> {
  const warnings: string[] = [];

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

    // Keyed on the NAME being missing, not on the ROW being missing, and the
    // difference is the whole warning.
    //
    // `flagOrphans` in the import commit inserts a `manpower` row with a NULL
    // `sm_name` for every SM_ID seen in transaction data but absent from the
    // roster sheet. That row makes `roster` truthy — so the old `if (!roster)`
    // check passed silently while `resolvedSmName` was still null and the patch
    // below cleared `sm_name` anyway. The single case the warning exists for is
    // exactly the case that suppressed it: an approval blanking a rep's name
    // with nothing said, on a screen whose entire job is to say what changed.
    //
    // The two states are still distinguishable and worth distinguishing: no row
    // at all means the roster has never heard of this code, whereas a row with
    // no name means the importer created a placeholder for it.
    if (!resolvedSmName) {
      warnings.push(
        roster
          ? `${newValue} has a roster entry with no name — it was created automatically from transaction data, not from a Manpower sheet — so the rep name was cleared rather than guessed. Ask an admin to import an up-to-date roster.`
          : `${newValue} is not in the Manpower roster, so the rep name was cleared rather than guessed. Ask an admin to add the roster entry.`,
      );
    }

    patch.smName = resolvedSmName;
    changedFields.push('smName');
  }

  const [updated] = await tx
    .update(salesRecord)
    .set(patch as Partial<typeof salesRecord.$inferInsert>)
    .where(eq(salesRecord.id, record.id))
    .returning();

  const appliedVersion = updated.currentVersion;

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
    changedBy: actor.id,
    correctionRequestId: request.id,
    note: `${label}: ${previousValue ?? '(empty)'} → ${newValue ?? '(empty)'}`,
  });

  // A second audit row against the record itself, not a duplicate of the
  // request's: the request trail answers "who decided what", the record trail
  // answers "what changed on this policy", and an auditor asking the second
  // question should not have to know a correction request existed.
  await writeAudit(
    {
      actor,
      action: 'RECORD_UPDATE',
      entityType: 'sales_record',
      entityId: record.id,
      before: snapshotFields(record, changedFields),
      after: snapshotFields(updated, changedFields),
      metadata: { appsNo: request.appsNo, correctionRequestId: request.id, appliedVersion },
      ipAddress: audit.ipAddress ?? null,
      userAgent: audit.userAgent ?? null,
    },
    tx,
  );

  const notifications = new Map<string, NotificationInput>();

  if (isMapping) {
    const losingSmId = record.smId;
    const gainingSmId = newValue ?? '';

    const [losing, gaining] = await Promise.all([
      findSalesUserBySmId(losingSmId, tx),
      findSalesUserBySmId(gainingSmId, tx),
    ]);

    /*
     * Direction changes only the WORDING, never the recipients — 2026-07-29
     * spec section 8.
     *
     * Losing and gaining are read off the record's current owner and the
     * proposed owner, which is why this block needed no restructuring when the
     * push direction arrived. But "an approved mapping claim moved this sale"
     * misdescribes a transfer to both parties at once: it tells the rep who
     * ASKED to give the sale away that somebody took it, and tells the receiver
     * that a claim they never made succeeded.
     *
     * On a TRANSFER_OUT the losing rep is the submitter, so the sentence is
     * addressed to someone reading the outcome of their own request.
     */
    const wasTransfer = request.direction === 'TRANSFER_OUT';

    // The losing rep is notified, not consulted (spec 7.2). Without this the
    // record simply disappears from their list, which is indistinguishable from
    // data loss and generates a support ticket instead of an understood
    // reassignment.
    if (losing && losingSmId !== gainingSmId) {
      const target = `${gainingSmId}${resolvedSmName ? ` (${resolvedSmName})` : ''}`;
      notifications.set(losing.id, {
        userId: losing.id,
        type: 'MAPPING_LOST',
        title: wasTransfer
          ? `Application ${request.appsNo} was transferred out of your book`
          : `Application ${request.appsNo} was reassigned`,
        body: wasTransfer
          ? `Your transfer request was approved and this sale has moved to ${target}.`
          : `An approved mapping claim moved this sale to ${target}. Raise your own mapping claim if you disagree.`,
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
        body: wasTransfer
          ? `${losingSmId} transferred this sale to your SM_ID and it was approved.`
          : `An approved mapping claim moved this sale to your SM_ID.`,
        link: recordLink(request.appsNo, 'sales'),
      });
    } else {
      warnings.push(`${gainingSmId} has no active portal account, so no reassignment notice was sent.`);
    }
  }

  return {
    recordId: record.id,
    fieldKey,
    label,
    previousValue,
    newValue,
    appliedVersion,
    warnings,
    notifications,
  };
}

/**
 * Sends the decision notice to whoever raised it AND to the rep whose book it
 * is, unless a mapping notice already covers that person.
 *
 * The Map keyed on userId is what makes "one row per person per event" true
 * regardless of how many of these overlap: a rep who raised their own mapping
 * transfer is the submitter, the owner and the losing party, and still gets
 * exactly one notification. `requestRecipients` collapses the first two, the Map
 * collapses the third.
 */
export async function notifySubmitterOfApproval(
  tx: DbTransaction,
  request: { id: string; appsNo: string; submittedBy: string; smId: string },
  applied: RecordApplication,
  remarks: string | null,
): Promise<void> {
  const { notifications } = applied;

  // The decision notice is skipped for anyone a MAPPING_* row already reached:
  // both link to the same reassignment and the mapping wording is strictly more
  // informative, so sending both is noise, not redundancy.
  for (const recipient of await requestRecipients(request, tx)) {
    if (notifications.has(recipient.userId)) continue;

    notifications.set(recipient.userId, {
      userId: recipient.userId,
      type: 'CORRECTION_APPROVED',
      title: `Correction approved — ${request.appsNo}`,
      body: `${applied.label} is now "${applied.newValue ?? '(empty)'}".${remarks ? ` Approver: ${remarks}` : ''}`,
      link: recipient.link,
    });
  }

  await notifyMany([...notifications.values()], tx);
}

/* ------------------------------------------------------------------ locking */

/**
 * Locks the record a request points at, then the request itself at `status`.
 *
 * In that order, and the order is the deadlock story: every path that touches
 * both takes the record first, so two concurrent decisions on different requests
 * against the same record queue rather than each holding what the other wants.
 */
export async function lockRecordAndRequest(
  tx: DbTransaction,
  requestId: string,
  status: 'PENDING' | 'VERIFIED',
): Promise<{ request: typeof correctionRequest.$inferSelect; record: RecordRow }> {
  const [initial] = await tx
    .select({ recordId: correctionRequest.recordId })
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!initial) {
    throw new ApprovalError('NOT_FOUND', 'That correction request no longer exists.');
  }

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
    .where(and(eq(correctionRequest.id, requestId), eq(correctionRequest.status, status)))
    .limit(1)
    .for('update');

  if (!request) {
    throw new ApprovalError('NOT_PENDING', await notApprovableMessage(tx, requestId));
  }

  return { request, record };
}

/**
 * Explains why a request somebody tried to act on was not actionable.
 *
 * Read outside the lock, after the locked read has already failed, so it costs
 * nothing on the path that succeeds.
 */
export async function notApprovableMessage(
  tx: DbTransaction,
  requestId: string,
): Promise<string> {
  const [exists] = await tx
    .select({ status: correctionRequest.status })
    .from(correctionRequest)
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!exists) return 'That correction request no longer exists.';

  if (exists.status === 'PENDING') {
    return 'This request has not been verified yet. A verifier has to check it before it can be approved.';
  }
  if (exists.status === 'RETURNED' || exists.status === 'WITHDRAWN') {
    return `This request is ${exists.status.toLowerCase()} and is back with the submitter.`;
  }
  return `This request is already ${exists.status.toLowerCase()} and cannot be decided again.`;
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
  record: RecordRow,
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
