import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  period,
  salesRecord,
  user,
} from '@/db/schema';
import { ageInDays } from '@/lib/format';
import { pageCount } from '@/lib/pagination';
import type { Page, QueueRow } from '@/lib/approvals/queries';
import {
  VERIFIER_HISTORY_ACTIONS,
  VERIFIER_OPEN_STATUSES,
  type VerifierHistoryFilters,
  type VerifierQueueFilters,
} from './schemas';

/**
 * Verifier reads — 2026-07-28 spec section 3.8.
 *
 * No SM_ID scoping here, exactly as in the approver's queries and for the same
 * reason: `scopedRecordCondition` already returns undefined for the verifier
 * role, and a verifier who could see only part of the queue would leave the rest
 * unverifiable by anyone.
 */

const submitter = alias(user, 'submitter');
const actor = alias(user, 'actor');

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

export type VerifierQueueRow = QueueRow & {
  periodLabel: string | null;
  periodStatus: string | null;
};

export async function listVerifierQueue(
  filters: VerifierQueueFilters,
  page: { page: number; pageSize: number; offset: number },
): Promise<Page<VerifierQueueRow>> {
  const statuses =
    filters.scope === 'OPEN' ? VERIFIER_OPEN_STATUSES : ([filters.scope] as const);

  const where = and(
    inArray(correctionRequest.status, [...statuses]),
    filters.category ? eq(correctionRequest.category, filters.category) : undefined,
    searchCondition(filters.q),
  );

  const selection = {
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
    periodLabel: period.label,
    periodStatus: period.status,
  };

  // Oldest first. A queue sorted newest-first starves its own tail: the request
  // nobody picked up on day one is the one that ages into a complaint.
  const rows = await db
    .select(selection)
    .from(correctionRequest)
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .leftJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .leftJoin(period, eq(period.id, correctionRequest.periodId))
    .where(where)
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

/**
 * Depth by scope for the filter chips.
 *
 * `verified` is included even though it is not the verifier's own work queue:
 * it is the number they handed on, and a figure that keeps climbing is how a
 * verifier notices the approver stage has stalled behind them.
 */
export async function verifierQueueCounts(): Promise<{
  pending: number;
  verified: number;
  returned: number;
  oldestDays: number;
}> {
  const rows = await db
    .select({
      status: correctionRequest.status,
      total: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${correctionRequest.submittedAt})`.mapWith(
        correctionRequest.submittedAt,
      ),
    })
    .from(correctionRequest)
    .where(inArray(correctionRequest.status, [...VERIFIER_OPEN_STATUSES]))
    .groupBy(correctionRequest.status);

  const of = (status: string) => rows.find((r) => r.status === status);
  const pending = of('PENDING');

  return {
    pending: pending?.total ?? 0,
    verified: of('VERIFIED')?.total ?? 0,
    returned: of('RETURNED')?.total ?? 0,
    oldestDays: pending?.oldest ? ageInDays(pending.oldest) : 0,
  };
}

/* ------------------------------------------------------------------ history */

export type VerifierHistoryRow = {
  eventId: string;
  requestId: string;
  action: string;
  decidedAt: Date;
  remarks: string | null;
  actorName: string | null;
  actorRole: string | null;
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
 * Read from `correction_event`, never from the request's own status — the same
 * reasoning as the approver's history. A request returned and then resubmitted
 * is PENDING again, and its status field has forgotten the return ever happened.
 *
 * The one addition here is the actor-role filter. Both stages write a RETURNED
 * event, so without it a verifier's history would list every return an APPROVER
 * made as if it were their own team's work.
 */
export async function listVerifierHistory(
  filters: VerifierHistoryFilters,
  page: { page: number; pageSize: number; offset: number },
  viewerId: string,
): Promise<Page<VerifierHistoryRow>> {
  const where = and(
    filters.action
      ? eq(correctionEvent.action, filters.action)
      : inArray(correctionEvent.action, [...VERIFIER_HISTORY_ACTIONS]),
    eq(actor.role, 'verifier'),
    filters.category ? eq(correctionRequest.category, filters.category) : undefined,
    filters.mine ? eq(correctionEvent.actorId, viewerId) : undefined,
    filters.from
      ? gte(correctionEvent.createdAt, new Date(`${filters.from}T00:00:00.000Z`))
      : undefined,
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
      actorRole: actor.role,
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
    .innerJoin(actor, eq(actor.id, correctionEvent.actorId))
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .where(where)
    .orderBy(desc(correctionEvent.createdAt))
    .limit(page.pageSize)
    .offset(page.offset);

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(correctionEvent)
    .innerJoin(correctionRequest, eq(correctionRequest.id, correctionEvent.requestId))
    .innerJoin(actor, eq(actor.id, correctionEvent.actorId))
    .where(where);

  const total = counted?.total ?? 0;

  return { rows, total, page: page.page, pageSize: page.pageSize, pageCount: pageCount(total, page.pageSize) };
}

/* ----------------------------------------------------------------- summary */

export type VerifierSummary = {
  pending: number;
  verified: number;
  returned: number;
  oldestPendingAt: Date | null;
  /** Verified in the last 7 days, by this verifier and by everyone. */
  verifiedThisWeekMine: number;
  verifiedThisWeekAll: number;
  /** Requests with no proof attached — a verification that cannot be done. */
  missingProof: number;
};

export async function getVerifierSummary(
  viewerId: string,
  now: number = Date.now(),
): Promise<VerifierSummary> {
  const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const counts = await verifierQueueCounts();

  const [oldest] = await db
    .select({
      at: sql<Date | null>`min(${correctionRequest.submittedAt})`.mapWith(
        correctionRequest.submittedAt,
      ),
    })
    .from(correctionRequest)
    .where(eq(correctionRequest.status, 'PENDING'));

  const [week] = await db
    .select({
      mine: sql<number>`count(*) filter (where ${correctionEvent.actorId} = ${viewerId})::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(correctionEvent)
    .where(
      and(
        eq(correctionEvent.action, 'VERIFIED'),
        gte(correctionEvent.createdAt, weekAgo),
      ),
    );

  // A pending request with no attachment cannot be verified against anything,
  // and the rep has to be told rather than left waiting. Surfaced on the
  // dashboard because it is the one queue condition a verifier cannot clear by
  // working harder.
  const [proofless] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(correctionRequest)
    .where(and(eq(correctionRequest.status, 'PENDING'), sql`${attachmentCount} = 0`));

  return {
    pending: counts.pending,
    verified: counts.verified,
    returned: counts.returned,
    oldestPendingAt: oldest?.at ?? null,
    verifiedThisWeekMine: week?.mine ?? 0,
    verifiedThisWeekAll: week?.all ?? 0,
    missingProof: proofless?.total ?? 0,
  };
}
