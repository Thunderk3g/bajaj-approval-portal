import { and, count, desc, eq, inArray, ne, or, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  correctionRequestStage,
  manpower,
  salesRecord,
  user,
} from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { PREVIEWABLE_MIME_TYPES } from '@/lib/storage/files';

/**
 * Reads for the sales-side correction screens.
 *
 * ## The visibility key
 *
 * These queries used to filter on `submitted_by = actor.id` alone, reasoning
 * that two reps can share an SM_ID over time as accounts are reissued, so a
 * request is the property of the person who raised it. That reasoning still
 * holds — for OWNERSHIP. It is why `loadOwnRequest` in service.ts, which gates
 * resubmit, withdraw and add-proof, is still keyed on `submitted_by` and nothing
 * here widens it.
 *
 * It does not hold for VISIBILITY of the book a rep currently holds. A TL or an
 * ACM may raise a correction on one of their reps' records (`docs/ui-flows.md`
 * §7 "raise on behalf of a rep"), and the row records the manager in
 * `submitted_by` and the rep's code in `sm_id`. Under the old predicate the rep
 * whose book it concerned could not see it anywhere. So reads — and only reads —
 * match `submitted_by = actor.id OR sm_id = actor.smId`.
 *
 * The widening is narrow on purpose: only a `role='sales'` account with an
 * SM_ID gets the second arm, and a reissued account inherits visibility of the
 * book it now holds, which is exactly what it can already see under
 * `/sales/records`. Nothing widens for tl/acm/admin/approver/verifier through
 * this module. The predicate is still in the WHERE clause rather than applied
 * after the read, so there is no code path that materialises a request against
 * somebody else's book at all.
 */

export type RequestListRow = {
  id: string;
  appsNo: string;
  category: string;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string | null;
  status: string;
  submittedAt: Date;
  lastResubmittedAt: Date | null;
  resubmissionCount: number;
  approverRemarks: string | null;
  attachmentCount: number;
  lastEventAction: string | null;
  lastEventAt: Date | null;
  /** Whose book the request concerns — the rep's code, even when a manager raised it. */
  smId: string;
  /** That rep's name off the roster, for the manager screens. Null when unrostered. */
  smName: string | null;
  /** Who raised it. Compared against the viewer to tell "mine" from "my manager's". */
  submittedBy: string;
  submitterName: string | null;
  /** The rung it is sitting on now, null once it is decided. */
  currentStageKey: string | null;
  currentStageSequence: number;
  totalStages: number;
};

export type RequestEvent = {
  id: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  remarks: string | null;
  createdAt: Date;
};

export type RequestAttachment = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: Date;
  /** Whether the proof route may be pointed at an `<img>` rather than a link. */
  previewable: boolean;
};

export type RequestDetail = {
  request: typeof correctionRequest.$inferSelect;
  events: RequestEvent[];
  attachments: RequestAttachment[];
  /** Who raised it, so a rep reading a manager-raised request is told plainly. */
  submitterName: string | null;
};

/**
 * The two statuses a submitter can still act on.
 *
 * `correction_status` carries WITHDRAWN as a real member, so the stored status
 * is truthful on its own and no screen has to reconstruct the label from the
 * event stream to avoid calling a rep's own cancellation a rejection.
 */
export const OPEN_REQUEST_STATUSES = ['PENDING', 'RETURNED'] as const;

export function isOpenRequest(status: string): boolean {
  return (OPEN_REQUEST_STATUSES as readonly string[]).includes(status);
}

/**
 * The one definition of "a request this actor may read".
 *
 * Every read in this module goes through it, so widening or narrowing visibility
 * is a single edit rather than four that have to agree. Writes do NOT use it —
 * see `loadOwnRequest` in service.ts.
 */
export function visibleRequestCondition(actor: SessionUser): SQL {
  const raisedByMe = eq(correctionRequest.submittedBy, actor.id);
  // Only a rep gets the second arm. A manager's `smId` is null and an admin's is
  // meaningless here, so anything else stays on the submitter key exactly as
  // before — this cannot become a back door into somebody else's queue.
  if (actor.role !== 'sales' || !actor.smId) return raisedByMe;
  return or(raisedByMe, eq(correctionRequest.smId, actor.smId)) as SQL;
}

export async function listMyRequests(
  actor: SessionUser,
  options: { offset: number; limit: number; status?: string },
): Promise<{ rows: RequestListRow[]; total: number }> {
  const visible = visibleRequestCondition(actor);
  const where = options.status
    ? and(
        visible,
        eq(
          correctionRequest.status,
          options.status as (typeof correctionRequest.$inferSelect)['status'],
        ),
      )
    : visible;

  const [totals] = await db.select({ value: count() }).from(correctionRequest).where(where);

  /**
   * Three left joins, none of which can multiply a row.
   *
   * `user` is the submitter's own row, `manpower.sm_id` is unique, and the
   * partial index behind `correction_request_stage` allows one ACTIVE rung per
   * request. Doing it here rather than in a second pass keeps the list one round
   * trip, which is what it was before the columns were added.
   */
  const rows = await db
    .select({
      request: correctionRequest,
      submitterName: user.name,
      smName: manpower.smName,
      currentStageKey: correctionRequestStage.stageKey,
    })
    .from(correctionRequest)
    .leftJoin(user, eq(user.id, correctionRequest.submittedBy))
    .leftJoin(manpower, eq(manpower.smId, correctionRequest.smId))
    .leftJoin(
      correctionRequestStage,
      and(
        eq(correctionRequestStage.requestId, correctionRequest.id),
        eq(correctionRequestStage.status, 'ACTIVE'),
      ),
    )
    .where(where)
    .orderBy(desc(correctionRequest.submittedAt))
    .limit(options.limit)
    .offset(options.offset);

  const requests = rows.map((r) => r.request);
  const ids = requests.map((r) => r.id);
  const [attachmentCounts, latestEvents] = await Promise.all([
    countAttachmentsFor(ids),
    latestEventFor(ids),
  ]);

  return {
    total: totals?.value ?? 0,
    rows: rows.map(({ request: r, submitterName, smName, currentStageKey }) => {
      const latest = latestEvents.get(r.id) ?? null;
      return {
        id: r.id,
        appsNo: r.appsNo,
        category: r.category,
        fieldLabel: r.fieldLabel,
        originalValue: r.originalValue,
        proposedValue: r.proposedValue,
        status: r.status,
        submittedAt: r.submittedAt,
        lastResubmittedAt: r.lastResubmittedAt,
        resubmissionCount: r.resubmissionCount,
        approverRemarks: r.approverRemarks,
        attachmentCount: attachmentCounts.get(r.id) ?? 0,
        lastEventAction: latest?.action ?? null,
        lastEventAt: latest?.createdAt ?? null,
        smId: r.smId,
        smName,
        submittedBy: r.submittedBy,
        submitterName,
        currentStageKey,
        currentStageSequence: r.currentStageSequence,
        totalStages: r.totalStages,
      };
    }),
  };
}

export async function getMyRequest(
  actor: SessionUser,
  requestId: string,
): Promise<RequestDetail | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(requestId)) return null;

  const [row] = await db
    .select({ request: correctionRequest, submitterName: user.name })
    .from(correctionRequest)
    .leftJoin(user, eq(user.id, correctionRequest.submittedBy))
    .where(and(eq(correctionRequest.id, requestId), visibleRequestCondition(actor)))
    .limit(1);

  if (!row) return null;
  const request = row.request;

  const [events, attachments] = await Promise.all([
    db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, request.id))
      .orderBy(correctionEvent.createdAt),
    db
      .select()
      .from(correctionAttachment)
      .where(eq(correctionAttachment.requestId, request.id))
      .orderBy(correctionAttachment.uploadedAt),
  ]);

  return {
    request,
    submitterName: row.submitterName,
    events: events.map((e) => ({
      id: e.id,
      action: e.action,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      remarks: e.remarks,
      createdAt: e.createdAt,
    })),
    attachments: attachments.map((a) => ({
      id: a.id,
      originalName: a.originalName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      sha256: a.sha256,
      uploadedAt: a.uploadedAt,
      previewable: PREVIEWABLE_MIME_TYPES.has(a.mimeType),
      // `stored_path` is deliberately absent. Nothing outside the proof route
      // needs to know where a customer document lives on disk, and a path that
      // reaches a page is a path that can reach a log or a browser.
    })),
  };
}

/* --------------------------------------------------- the counterparty view */

/**
 * The statuses that put a mapping request on the counterparty's screen.
 *
 * The same triple as `LOCKING_STATUSES` and as the predicate of
 * `correction_mapping_proposed_open`, and it must stay in step with both: the
 * index is what makes this query cheap, and a status in one list and not the
 * other produces either a sequential scan or a row the rep never sees.
 *
 * RETURNED is included even though the request is momentarily back with its
 * submitter. It is still live — it holds the record's one open-request slot and
 * will re-enter the queue — so hiding it would tell the counterparty a
 * reassignment had gone away when it had not.
 */
export const COUNTERPARTY_STATUSES = ['PENDING', 'VERIFIED', 'RETURNED'] as const;

export type CounterpartyRow = {
  id: string;
  appsNo: string;
  policyNo: string | null;
  clientName: string | null;
  productName: string | null;
  recordStatus: string | null;
  issuedDate: string | null;
  direction: string;
  status: string;
  submittedAt: Date;
  /** The rep who holds the sale now. */
  currentSmId: string;
  /** The rep the request would move it to. */
  proposedSmId: string;
  /** Which side of it this viewer is on, in their own terms. */
  role: 'LOSING' | 'GAINING';
};

/**
 * Open mapping requests where this rep is the OTHER party — 2026-07-29 spec
 * section 5.
 *
 * Until this existed a rep learned that a sale was leaving their book only when
 * it had already left: the notification pair fires at approval. This is the same
 * information one review cycle earlier, on both sides and in both directions.
 *
 * ## Why this does not widen the read scope
 *
 * The obvious alternative is to make an incoming record appear in the receiving
 * rep's `/sales/records`, which means widening `scopedRecordCondition` — the one
 * helper whose whole job is to be the only way record reads get scoped, and
 * whose sales branch throws rather than return `undefined` so that a bug there
 * cannot become a full-table read.
 *
 * This query leaves it alone. It has its own explicit predicate, it can only
 * return rows naming this rep's SM_ID on one side or the other, and it projects
 * the section 7.2 columns and no more — no premium figures, no attachments, no
 * `stored_path`. A rep sees the identity of a policy they are party to, which is
 * strictly less than the record page would give them.
 *
 * ## Why `submitted_by <> actor.id`
 *
 * Without it this returns the rep's own requests too, which they already see
 * under "My requests" — and a rep who claimed a sale would find their own claim
 * listed as something being done TO them.
 *
 * Note the asymmetry with the rest of this module, which filters on
 * `submitted_by = actor.id`. Here the SM_ID genuinely is the right key: the
 * question is "does this reassignment touch my book", and a book belongs to an
 * SM_ID, not to a person. The `submitted_by` clause is an exclusion, not the
 * scope.
 *
 * ## Why `sm_id <> actor.smId` joined it
 *
 * `visibleRequestCondition` now also matches `sm_id = actor.smId`, so a mapping
 * request raised for this rep BY THEIR MANAGER satisfies both this query and
 * "My requests" — and the rep would read their own claim twice, once as theirs
 * and once as something being done to them. `submitted_by <> actor.id` no
 * longer covers that case on its own, because the submitter is the manager.
 *
 * Excluding on the same column the other query includes on is what keeps the two
 * lists disjoint by construction. A row where this rep's code is on the OTHER
 * side is untouched: for a CLAIM_IN `sm_id` is the claimant's, for a
 * TRANSFER_OUT it is the current holder's, so the counterparty is never the one
 * named by `sm_id`.
 */
export async function listCounterpartyRequests(actor: SessionUser): Promise<CounterpartyRow[]> {
  // Same reasoning as `scopedRecordCondition`: a sales account with no SM_ID is
  // scoped to nothing, and must return nothing rather than fall through to a
  // predicate that matches every row whose proposed_value happens to be null.
  if (actor.role !== 'sales' || !actor.smId) return [];
  const smId = actor.smId;

  const rows = await db
    .select({
      id: correctionRequest.id,
      appsNo: correctionRequest.appsNo,
      direction: correctionRequest.direction,
      status: correctionRequest.status,
      submittedAt: correctionRequest.submittedAt,
      proposedSmId: correctionRequest.proposedValue,
      currentSmId: salesRecord.smId,
      policyNo: salesRecord.policyNo,
      clientName: salesRecord.clientName,
      productName: salesRecord.productName,
      recordStatus: salesRecord.status,
      issuedDate: salesRecord.issuedDate,
    })
    .from(correctionRequest)
    .innerJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .where(
      and(
        eq(correctionRequest.category, 'MAPPING'),
        inArray(correctionRequest.status, [...COUNTERPARTY_STATUSES]),
        ne(correctionRequest.submittedBy, actor.id),
        // …and not one raised for this rep's own book by their manager, which
        // "My requests" above now shows. See the docblock.
        ne(correctionRequest.smId, smId),
        // Either side. A rep can be the one losing the sale or the one gaining
        // it, and which of the two is a property of the row, not of the query.
        or(eq(salesRecord.smId, smId), eq(correctionRequest.proposedValue, smId)),
      ),
    )
    .orderBy(desc(correctionRequest.submittedAt));

  return rows.map((r) => ({
    id: r.id,
    appsNo: r.appsNo,
    policyNo: r.policyNo,
    clientName: r.clientName,
    productName: r.productName,
    recordStatus: r.recordStatus,
    issuedDate: r.issuedDate,
    // Non-null in practice — the CHECK makes a MAPPING row without a direction
    // unrepresentable — but the column is nullable for the other categories, so
    // the type says so and the fallback keeps a bad row from blanking the cell.
    direction: r.direction ?? 'CLAIM_IN',
    status: r.status,
    submittedAt: r.submittedAt,
    currentSmId: r.currentSmId,
    proposedSmId: r.proposedSmId,
    // Derived from the SM_IDs rather than from the direction: direction says who
    // ASKED, and the viewer wants to know what happens to THEM. A rep reading
    // this list is losing the sale if they hold it now, whoever raised it.
    role: r.currentSmId === smId ? ('LOSING' as const) : ('GAINING' as const),
  }));
}

/** Status tallies for the requests header and the sales dashboard. */
export async function countMyRequestsByStatus(
  actor: SessionUser,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: correctionRequest.status, value: count() })
    .from(correctionRequest)
    .where(visibleRequestCondition(actor))
    .groupBy(correctionRequest.status);

  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = row.value;
  return out;
}

async function countAttachmentsFor(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({ requestId: correctionAttachment.requestId, value: count() })
    .from(correctionAttachment)
    .where(inArray(correctionAttachment.requestId, ids))
    .groupBy(correctionAttachment.requestId);

  return new Map(rows.map((r) => [r.requestId, r.value]));
}

async function latestEventFor(
  ids: string[],
): Promise<Map<string, { action: string; createdAt: Date }>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      requestId: correctionEvent.requestId,
      action: correctionEvent.action,
      createdAt: correctionEvent.createdAt,
    })
    .from(correctionEvent)
    .where(inArray(correctionEvent.requestId, ids))
    .orderBy(correctionEvent.requestId, desc(correctionEvent.createdAt));

  const latest = new Map<string, { action: string; createdAt: Date }>();
  for (const row of rows) {
    // Ordered newest-first per request, so the first row seen for an id wins.
    if (!latest.has(row.requestId)) {
      latest.set(row.requestId, { action: row.action, createdAt: row.createdAt });
    }
  }
  return latest;
}
