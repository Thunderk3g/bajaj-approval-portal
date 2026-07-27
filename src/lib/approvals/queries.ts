import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  manpower,
  salesRecord,
  salesRecordVersion,
  user,
} from '@/db/schema';
import { ageInDays } from '@/lib/format';
import { pageCount } from '@/lib/pagination';
import { HISTORY_ACTIONS, type HistoryFilters, type QueueFilters } from './schemas';

/**
 * Approver reads — spec sections 9 and 9.1.
 *
 * No SM_ID scoping appears anywhere in this file, and that is deliberate rather
 * than an omission: `scopedRecordCondition` already returns `undefined` for the
 * approver role (spec 4.1), and an approver who could only see part of the queue
 * would leave the rest unreviewable by anyone.
 */

const submitter = alias(user, 'submitter');
const reviewer = alias(user, 'reviewer');
const actor = alias(user, 'actor');

/** Correlated rather than a join: a join on attachments would multiply rows. */
const attachmentCount = sql<number>`(
  select count(*)::int from ${correctionAttachment}
  where ${correctionAttachment.requestId} = ${correctionRequest.id}
)`;

function searchCondition(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  const pattern = `%${q}%`;
  return or(
    ilike(correctionRequest.appsNo, pattern),
    ilike(correctionRequest.smId, pattern),
    ilike(submitter.name, pattern),
    ilike(salesRecord.clientName, pattern),
  );
}

/* -------------------------------------------------------------------- queue */

export type QueueRow = {
  id: string;
  appsNo: string;
  category: string;
  status: string;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string;
  description: string | null;
  smId: string;
  submittedAt: Date;
  lastResubmittedAt: Date | null;
  resubmissionCount: number;
  submitterName: string | null;
  submitterEmail: string | null;
  clientName: string | null;
  recordStatus: string | null;
  attachments: number;
  /** Whole days since submission — spec 9 asks the queue to surface ageing. */
  ageDays: number;
};

export type Page<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

export async function listQueue(
  filters: QueueFilters,
  page: { page: number; pageSize: number; offset: number },
): Promise<Page<QueueRow>> {
  const statuses =
    filters.scope === 'OPEN' ? (['PENDING', 'RETURNED'] as const) : ([filters.scope] as const);

  const where = and(
    inArray(correctionRequest.status, [...statuses]),
    filters.category ? eq(correctionRequest.category, filters.category) : undefined,
    searchCondition(filters.q),
  );

  const base = db
    .select({
      id: correctionRequest.id,
      appsNo: correctionRequest.appsNo,
      category: correctionRequest.category,
      status: correctionRequest.status,
      fieldLabel: correctionRequest.fieldLabel,
      originalValue: correctionRequest.originalValue,
      proposedValue: correctionRequest.proposedValue,
      description: correctionRequest.description,
      smId: correctionRequest.smId,
      submittedAt: correctionRequest.submittedAt,
      lastResubmittedAt: correctionRequest.lastResubmittedAt,
      resubmissionCount: correctionRequest.resubmissionCount,
      submitterName: submitter.name,
      submitterEmail: submitter.email,
      clientName: salesRecord.clientName,
      recordStatus: salesRecord.status,
      attachments: attachmentCount,
    })
    .from(correctionRequest)
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .leftJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .where(where);

  // Oldest first. A queue sorted newest-first starves its own tail: the request
  // nobody picked up on day one is the one that ages into a complaint.
  const rows = await base
    .orderBy(asc(correctionRequest.submittedAt))
    .limit(page.pageSize)
    .offset(page.offset);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(correctionRequest)
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .leftJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .where(where);

  const total = counted?.total ?? 0;

  return {
    rows: rows.map((r) => ({ ...r, ageDays: ageInDays(r.submittedAt) })),
    total,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: pageCount(total, page.pageSize),
  };
}

/** Queue depth by scope, for the filter chips. */
export async function queueCounts(): Promise<{ pending: number; returned: number; oldestDays: number }> {
  const rows = await db
    .select({
      status: correctionRequest.status,
      total: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${correctionRequest.submittedAt})`,
    })
    .from(correctionRequest)
    .where(inArray(correctionRequest.status, ['PENDING', 'RETURNED']))
    .groupBy(correctionRequest.status);

  const pending = rows.find((r) => r.status === 'PENDING');
  const returned = rows.find((r) => r.status === 'RETURNED');

  return {
    pending: pending?.total ?? 0,
    returned: returned?.total ?? 0,
    oldestDays: pending?.oldest ? ageInDays(pending.oldest) : 0,
  };
}

/* ------------------------------------------------------------------ history */

export type HistoryRow = {
  eventId: string;
  requestId: string;
  action: string;
  decidedAt: Date;
  remarks: string | null;
  actorName: string | null;
  appsNo: string;
  category: string;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string;
  currentStatus: string;
  smId: string;
  submitterName: string | null;
};

/**
 * History is read from `correction_event`, not from the request's own status.
 *
 * A request that was returned and then resubmitted is `PENDING` again, and its
 * status field has forgotten the return ever happened. The event table is the
 * only place a decision survives the next transition (spec 5.8), so a decision
 * log built from `correction_request.status` would silently under-report every
 * approver who asked for a better proof.
 */
export async function listHistory(
  filters: HistoryFilters,
  page: { page: number; pageSize: number; offset: number },
  viewerId: string,
): Promise<Page<HistoryRow>> {
  const where = and(
    filters.action
      ? eq(correctionEvent.action, filters.action)
      : inArray(correctionEvent.action, [...HISTORY_ACTIONS]),
    filters.category ? eq(correctionRequest.category, filters.category) : undefined,
    filters.mine ? eq(correctionEvent.actorId, viewerId) : undefined,
    filters.from ? gte(correctionEvent.createdAt, new Date(`${filters.from}T00:00:00.000Z`)) : undefined,
    filters.to ? lte(correctionEvent.createdAt, new Date(`${filters.to}T23:59:59.999Z`)) : undefined,
    filters.q
      ? or(
          ilike(correctionRequest.appsNo, `%${filters.q}%`),
          ilike(correctionRequest.smId, `%${filters.q}%`),
        )
      : undefined,
  );

  const rows = await db
    .select({
      eventId: correctionEvent.id,
      requestId: correctionEvent.requestId,
      action: correctionEvent.action,
      decidedAt: correctionEvent.createdAt,
      remarks: correctionEvent.remarks,
      actorName: actor.name,
      appsNo: correctionRequest.appsNo,
      category: correctionRequest.category,
      fieldLabel: correctionRequest.fieldLabel,
      originalValue: correctionRequest.originalValue,
      proposedValue: correctionRequest.proposedValue,
      currentStatus: correctionRequest.status,
      smId: correctionRequest.smId,
      submitterName: submitter.name,
    })
    .from(correctionEvent)
    .innerJoin(correctionRequest, eq(correctionRequest.id, correctionEvent.requestId))
    .leftJoin(actor, eq(actor.id, correctionEvent.actorId))
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .where(where)
    .orderBy(desc(correctionEvent.createdAt))
    .limit(page.pageSize)
    .offset(page.offset);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(correctionEvent)
    .innerJoin(correctionRequest, eq(correctionRequest.id, correctionEvent.requestId))
    .where(where);

  const total = counted?.total ?? 0;

  return {
    rows,
    total,
    page: page.page,
    pageSize: page.pageSize,
    pageCount: pageCount(total, page.pageSize),
  };
}

/* ------------------------------------------------------------------- detail */

export type MappingContext = {
  currentSmId: string;
  currentSmName: string | null;
  currentRosterName: string | null;
  currentInRoster: boolean;
  currentAccount: { name: string; email: string } | null;
  claimSmId: string;
  claimRosterName: string | null;
  claimInRoster: boolean;
  claimAccount: { name: string; email: string } | null;
};

export type RequestDetail = NonNullable<Awaited<ReturnType<typeof getRequestDetail>>>;

export async function getRequestDetail(requestId: string) {
  const [row] = await db
    .select({
      request: correctionRequest,
      record: salesRecord,
      submitterName: submitter.name,
      submitterEmail: submitter.email,
      submitterSmId: submitter.smId,
      reviewerName: reviewer.name,
      reviewerEmail: reviewer.email,
    })
    .from(correctionRequest)
    .innerJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .leftJoin(reviewer, eq(reviewer.id, correctionRequest.reviewedBy))
    .where(eq(correctionRequest.id, requestId))
    .limit(1);

  if (!row) return null;

  const [attachments, events, versions] = await Promise.all([
    db
      .select()
      .from(correctionAttachment)
      .where(eq(correctionAttachment.requestId, requestId))
      .orderBy(asc(correctionAttachment.uploadedAt)),
    db
      .select({
        id: correctionEvent.id,
        action: correctionEvent.action,
        fromStatus: correctionEvent.fromStatus,
        toStatus: correctionEvent.toStatus,
        remarks: correctionEvent.remarks,
        createdAt: correctionEvent.createdAt,
        actorName: actor.name,
        actorRole: actor.role,
      })
      .from(correctionEvent)
      .leftJoin(actor, eq(actor.id, correctionEvent.actorId))
      .where(eq(correctionEvent.requestId, requestId))
      .orderBy(asc(correctionEvent.createdAt)),
    db
      .select({
        version: salesRecordVersion.version,
        changedFields: salesRecordVersion.changedFields,
        changedAt: salesRecordVersion.changedAt,
        note: salesRecordVersion.note,
      })
      .from(salesRecordVersion)
      .where(eq(salesRecordVersion.recordId, row.record.id))
      .orderBy(desc(salesRecordVersion.version)),
  ]);

  const mapping =
    row.request.category === 'MAPPING'
      ? await mappingContext(row.record.smId, row.record.smName, row.request.proposedValue)
      : null;

  return { ...row, attachments, events, versions, mapping };
}

/**
 * Both reps' identities, side by side, before the approver decides (spec 7.2).
 *
 * The roster lookup runs here rather than only at approval time so the approver
 * learns that an SM_ID is unknown to the `Manpower` sheet *before* committing to
 * a reassignment that will leave the name blank — seven such IDs exist in the
 * June data.
 */
async function mappingContext(
  currentSmId: string,
  currentSmName: string | null,
  proposedSmId: string,
): Promise<MappingContext> {
  const claimSmId = proposedSmId.trim().toUpperCase();

  const roster = await db
    .select({ smId: manpower.smId, smName: manpower.smName })
    .from(manpower)
    .where(inArray(manpower.smId, [currentSmId, claimSmId]));

  const accounts = await db
    .select({ smId: user.smId, name: user.name, email: user.email })
    .from(user)
    .where(
      and(
        eq(user.role, 'sales'),
        eq(user.isActive, true),
        inArray(user.smId, [currentSmId, claimSmId]),
      ),
    );

  const rosterFor = (smId: string) => roster.find((r) => r.smId === smId);
  const accountFor = (smId: string) => {
    const found = accounts.find((a) => a.smId === smId);
    return found ? { name: found.name, email: found.email } : null;
  };

  return {
    currentSmId,
    currentSmName,
    currentRosterName: rosterFor(currentSmId)?.smName ?? null,
    currentInRoster: Boolean(rosterFor(currentSmId)),
    currentAccount: accountFor(currentSmId),
    claimSmId,
    claimRosterName: rosterFor(claimSmId)?.smName ?? null,
    claimInRoster: Boolean(rosterFor(claimSmId)),
    claimAccount: accountFor(claimSmId),
  };
}
