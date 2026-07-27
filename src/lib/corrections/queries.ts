import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionEvent, correctionRequest } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { PREVIEWABLE_MIME_TYPES } from '@/lib/storage/files';

/**
 * Reads for the sales-side correction screens.
 *
 * Every query in this file filters on `submitted_by = actor.id`. Not
 * `sm_id = actor.smId`: two reps can share an SM_ID over time as accounts are
 * reissued, and a request is the property of the person who raised it. The
 * predicate is in the WHERE clause rather than applied after the read, so there
 * is no code path that materialises somebody else's request at all.
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

export async function listMyRequests(
  actor: SessionUser,
  options: { offset: number; limit: number; status?: string },
): Promise<{ rows: RequestListRow[]; total: number }> {
  const where = options.status
    ? and(
        eq(correctionRequest.submittedBy, actor.id),
        eq(
          correctionRequest.status,
          options.status as (typeof correctionRequest.$inferSelect)['status'],
        ),
      )
    : eq(correctionRequest.submittedBy, actor.id);

  const [totals] = await db.select({ value: count() }).from(correctionRequest).where(where);

  const requests = await db
    .select()
    .from(correctionRequest)
    .where(where)
    .orderBy(desc(correctionRequest.submittedAt))
    .limit(options.limit)
    .offset(options.offset);

  const ids = requests.map((r) => r.id);
  const [attachmentCounts, latestEvents] = await Promise.all([
    countAttachmentsFor(ids),
    latestEventFor(ids),
  ]);

  return {
    total: totals?.value ?? 0,
    rows: requests.map((r) => {
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
      };
    }),
  };
}

export async function getMyRequest(
  actor: SessionUser,
  requestId: string,
): Promise<RequestDetail | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(requestId)) return null;

  const [request] = await db
    .select()
    .from(correctionRequest)
    .where(and(eq(correctionRequest.id, requestId), eq(correctionRequest.submittedBy, actor.id)))
    .limit(1);

  if (!request) return null;

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

/** Status tallies for the requests header and the sales dashboard. */
export async function countMyRequestsByStatus(
  actor: SessionUser,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: correctionRequest.status, value: count() })
    .from(correctionRequest)
    .where(eq(correctionRequest.submittedBy, actor.id))
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
