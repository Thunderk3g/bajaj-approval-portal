import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, period, salesRecord, uploadBatch, user } from '@/db/schema';
import { LOCKING_STATUSES } from '@/lib/corrections/service';

/** Reads for the admin Periods screen. Callers have already authorized. */

export type PeriodSummary = {
  id: string;
  code: string;
  label: string;
  startsOn: string;
  endsOn: string;
  status: string;
  closedAt: Date | null;
  closedByName: string | null;
  records: number;
  batches: number;
  /** Requests raised in this cycle, whatever their state now. */
  requests: number;
  /** Still in flight: PENDING, VERIFIED or RETURNED. */
  openRequests: number;
};

/**
 * Every period with its counts.
 *
 * Correlated subqueries rather than joins: a join to `sales_record` and another
 * to `correction_request` from the same row multiplies them together, and the
 * record count would come back as records × requests. There are at most a few
 * dozen periods ever, so the correlated form costs nothing worth optimising.
 */
export async function listPeriodSummaries(): Promise<PeriodSummary[]> {
  const openList = LOCKING_STATUSES.map((s) => `'${s}'`).join(',');

  return db
    .select({
      id: period.id,
      code: period.code,
      label: period.label,
      startsOn: period.startsOn,
      endsOn: period.endsOn,
      status: period.status,
      closedAt: period.closedAt,
      closedByName: user.name,
      records: sql<number>`(
        select count(*)::int from ${salesRecord}
        where ${salesRecord.periodId} = ${period.id}
      )`,
      batches: sql<number>`(
        select count(*)::int from ${uploadBatch}
        where ${uploadBatch.periodCode} = ${period.code}
          and ${uploadBatch.status} = 'COMMITTED'
      )`,
      requests: sql<number>`(
        select count(*)::int from ${correctionRequest}
        where ${correctionRequest.periodId} = ${period.id}
      )`,
      openRequests: sql<number>`(
        select count(*)::int from ${correctionRequest}
        where ${correctionRequest.periodId} = ${period.id}
          and ${correctionRequest.status} in (${sql.raw(openList)})
      )`,
    })
    .from(period)
    .leftJoin(user, eq(user.id, period.closedBy))
    .orderBy(sql`${period.code} desc`);
}

/**
 * What an admin sees before confirming a close.
 *
 * Split by stage, not just totalled. "12 open requests" reads as a reason to
 * wait; "9 awaiting verification, 3 awaiting approval" tells the admin who to
 * chase — and closing does not block any of them anyway, so the only value this
 * has is telling somebody what to do next.
 */
export type CloseImpact = {
  label: string;
  pending: number;
  verified: number;
  returned: number;
  total: number;
};

export async function closeImpact(periodId: string): Promise<CloseImpact | null> {
  const [row] = await db
    .select({ label: period.label })
    .from(period)
    .where(eq(period.id, periodId))
    .limit(1);

  if (!row) return null;

  const rows = await db
    .select({ status: correctionRequest.status, total: sql<number>`count(*)::int` })
    .from(correctionRequest)
    .where(
      and(
        eq(correctionRequest.periodId, periodId),
        sql`${correctionRequest.status} in ('PENDING','VERIFIED','RETURNED')`,
      ),
    )
    .groupBy(correctionRequest.status);

  const of = (status: string) => rows.find((r) => r.status === status)?.total ?? 0;
  const pending = of('PENDING');
  const verified = of('VERIFIED');
  const returned = of('RETURNED');

  return { label: row.label, pending, verified, returned, total: pending + verified + returned };
}

/**
 * Period options for a filter dropdown, newest first.
 *
 * Includes closed periods: a closed month is exactly what somebody wants to
 * filter a report to, and hiding it would make the close look like deletion.
 */
export async function periodOptions(): Promise<
  Array<{ id: string; code: string; label: string; status: string }>
> {
  return db
    .select({ id: period.id, code: period.code, label: period.label, status: period.status })
    .from(period)
    .orderBy(sql`${period.code} desc`)
    .limit(60);
}
