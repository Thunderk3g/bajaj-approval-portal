import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  correctionAttachment,
  correctionEvent,
  correctionRequest,
  manpower,
  period,
  salesRecord,
  salesRecordVersion,
  user,
} from '@/db/schema';
import { ageInDays } from '@/lib/format';
import { pageCount } from '@/lib/pagination';
import { scopedRecordCondition, type SessionUser } from '@/lib/auth/rbac';
import { likePattern } from '@/lib/records/query';
import { actorStageCondition } from '@/lib/workflows/engine';
import {
  HISTORY_ACTIONS,
  OPEN_QUEUE_STATUSES,
  type HistoryFilters,
  type QueueFilters,
} from './schemas';

/**
 * Approver reads — spec sections 9 and 9.1.
 *
 * The queue and history are unscoped, and that is deliberate rather than an
 * omission: `scopedRecordCondition` already returns `undefined` for the approver
 * role (spec 4.1), and an approver who could only see part of the queue would
 * leave the rest unreviewable by anyone.
 *
 * `getRequestDetail` is NOT in that category and takes a viewer, because it grew
 * two callers the rest of this file was never written for — the TL and ACM
 * request screens. Those roles are scoped, and reading a request by id alone
 * handed either of them any request in the company: client name, policy number,
 * premium, both mapping counterparties, the record's whole version history and
 * every remark on it. See the note above the function.
 */

const submitter = alias(user, 'submitter');
const reviewer = alias(user, 'reviewer');
const checker = alias(user, 'checker');
const actor = alias(user, 'actor');

/** Correlated rather than a join: a join on attachments would multiply rows. */
const attachmentCount = sql<number>`(
  select count(*)::int from ${correctionAttachment}
  where ${correctionAttachment.requestId} = ${correctionRequest.id}
)`;

function searchCondition(q: string | undefined): SQL | undefined {
  if (!q) return undefined;
  // Escaped, not interpolated: an unescaped `%` or `_` from the search box is a
  // wildcard, so searching for `100%` matched every row. `likePattern` is the
  // record grid's escaper and is shared rather than restated.
  const pattern = likePattern(q);
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
  /** `CLAIM_IN` | `TRANSFER_OUT` on a mapping request, null on every other category. */
  direction: string | null;
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
  // `viewer`, not `actor`: this module binds `actor` to a `user` table alias
  // used by the history query, and a parameter of that name shadows it.
  viewer: { id: string; role: string },
): Promise<Page<QueueRow>> {
  // `MINE` reads the stage table, every other scope reads the status column.
  // See QUEUE_SCOPES for why those stopped being the same question.
  const scopeCondition =
    filters.scope === 'MINE'
      ? actorStageCondition(viewer)
      : inArray(correctionRequest.status, [
          ...(filters.scope === 'OPEN' ? OPEN_QUEUE_STATUSES : ([filters.scope] as const)),
        ]);

  const where = and(
    scopeCondition,
    filters.category ? eq(correctionRequest.category, filters.category) : undefined,
    searchCondition(filters.q),
  );

  const base = db
    .select({
      id: correctionRequest.id,
      appsNo: correctionRequest.appsNo,
      category: correctionRequest.category,
      // Carried into the queue because MAPPING no longer describes one thing —
      // 2026-07-29 spec section 7. A claim and a transfer show the same badge
      // and the same smId → smId change, and which one it is decides what the
      // reviewer should be checking.
      direction: correctionRequest.direction,
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

/**
 * Queue depth by scope, for the filter chips.
 *
 * `awaitingDecision` counts VERIFIED — the approver's actual work — and
 * `awaitingVerification` counts PENDING, which is upstream of them. Keeping both
 * is what stops a cleared approver queue reading as "nothing to do" when fifty
 * requests are stacked behind an unattended verifier.
 *
 * Ageing is measured from `submittedAt` in both cases, not from the moment of
 * verification: the rep has been waiting since they submitted, and an SLA that
 * restarted at each stage would report a three-week-old request as one day old.
 */
export async function queueCounts(viewer: { id: string; role: string }): Promise<{
  awaitingDecision: number;
  awaitingVerification: number;
  returned: number;
  oldestDays: number;
}> {
  const [rows, [mine]] = await Promise.all([
    db
      .select({
        status: correctionRequest.status,
        total: sql<number>`count(*)::int`,
      })
      .from(correctionRequest)
      .where(inArray(correctionRequest.status, [...OPEN_QUEUE_STATUSES]))
      .groupBy(correctionRequest.status),
    // "Awaiting MY decision" now means exactly that. Counted off the stage table
    // rather than off `status = 'VERIFIED'`, which since the N-stage engine also
    // covers requests parked with two managers and a second verifier — work the
    // approver was being shown, invited to act on, and then refused.
    db
      .select({
        total: sql<number>`count(*)::int`,
        oldest: sql<Date | null>`min(${correctionRequest.submittedAt})`.mapWith(
          correctionRequest.submittedAt,
        ),
      })
      .from(correctionRequest)
      .where(actorStageCondition(viewer)),
  ]);

  const of = (status: string) => rows.find((r) => r.status === status);

  return {
    awaitingDecision: mine?.total ?? 0,
    awaitingVerification: of('PENDING')?.total ?? 0,
    returned: of('RETURNED')?.total ?? 0,
    oldestDays: mine?.oldest ? ageInDays(mine.oldest) : 0,
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
          ilike(correctionRequest.appsNo, likePattern(filters.q)),
          ilike(correctionRequest.smId, likePattern(filters.q)),
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

/**
 * One request, in full, for whoever is entitled to read it.
 *
 * The viewer argument is required rather than optional, and that is the fix
 * itself. This function was written for the approver and verifier screens, both
 * of which read globally, so it selected by id alone. The TL and ACM request
 * screens were later added as callers — and those roles are scoped. A team
 * leader who followed a notification link, or simply changed the UUID in the
 * address bar, was served any request in the company: the customer's name and
 * policy number, the premium, both sides of a mapping claim, the record's entire
 * version history and every remark anyone had written on it. Only the decision
 * form was gated; the reading was not.
 *
 * An optional parameter would have left the same hole open by default for the
 * next caller. Required means a new screen cannot be written without answering
 * "on whose behalf", which is the only question that matters here.
 *
 * `scopedRecordCondition` composes straight into the WHERE because the query
 * already inner-joins `sales_record`: it is `undefined` for the three global
 * roles, so their behaviour is unchanged, and an `sm_id IN (…)` predicate for
 * everyone else. Out-of-scope returns null, which every caller renders as
 * `notFound()` — deliberately indistinguishable from a request that does not
 * exist, the same rule `getRecord` follows.
 */
export async function getRequestDetail(viewer: SessionUser, requestId: string) {
  const [row] = await db
    .select({
      request: correctionRequest,
      record: salesRecord,
      submitterName: submitter.name,
      submitterEmail: submitter.email,
      submitterSmId: submitter.smId,
      reviewerName: reviewer.name,
      reviewerEmail: reviewer.email,
      // The first gate, shown to the approver before they decide. Knowing a
      // colleague already checked this against its proof — and what they said —
      // is the whole point of the stage; without it on screen the approver is
      // repeating the work rather than building on it.
      verifierName: checker.name,
      verifierEmail: checker.email,
      periodLabel: period.label,
      periodStatus: period.status,
    })
    .from(correctionRequest)
    .innerJoin(salesRecord, eq(salesRecord.id, correctionRequest.recordId))
    .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
    .leftJoin(reviewer, eq(reviewer.id, correctionRequest.reviewedBy))
    .leftJoin(checker, eq(checker.id, correctionRequest.verifiedBy))
    .leftJoin(period, eq(period.id, correctionRequest.periodId))
    .where(and(eq(correctionRequest.id, requestId), scopedRecordCondition(viewer)))
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
