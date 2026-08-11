import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, period, salesRecord, uploadBatch, user } from '@/db/schema';
import { LOCKING_STATUSES } from '@/lib/corrections/service';
import { currentPeriod, isPeriodCode, periodCodeFor, periodLabelFor } from './service';

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
 * Which cycle a batch will land in, and whether that cycle is closed.
 *
 * Read BEFORE the commit rather than discovered as a thrown `PeriodError` after
 * it: a closed month is the one refusal an admin can do something about, and
 * learning about it at the last button is what sent them off to /admin/periods
 * and back again.
 *
 * The code is resolved exactly as `commitBatch` resolves it — the stored
 * `period_code`, else the calendar month of the upload. Two spellings of that
 * fallback is the bug this shares one line to avoid.
 */
export type BatchPeriodState = {
  code: string;
  label: string;
  /** `null` when no row exists yet: the commit creates it, open. */
  status: 'OPEN' | 'CLOSED' | null;
  /** The period that is open right now, when it is a DIFFERENT one. */
  openElsewhere: { code: string; label: string } | null;
  /** Records already sitting in this cycle — the blast radius of reopening it. */
  records: number;
};

export async function batchPeriodState(batch: {
  periodCode: string | null;
  uploadedAt: Date;
}): Promise<BatchPeriodState> {
  const code = batch.periodCode ?? periodCodeFor(batch.uploadedAt);

  const [row] = await db.select().from(period).where(eq(period.code, code)).limit(1);
  const open = await currentPeriod();

  const records = row
    ? ((
        await db
          .select({ value: count() })
          .from(salesRecord)
          .where(eq(salesRecord.periodId, row.id))
      )[0]?.value ?? 0)
    : 0;

  return {
    code,
    // A stored code that is not `YYYY-MM` cannot be labelled and must not throw
    // on a read: the commit is where that is refused, in a sentence.
    label: row?.label ?? (isPeriodCode(code) ? periodLabelFor(code) : code),
    status: row ? (row.status as 'OPEN' | 'CLOSED') : null,
    openElsewhere:
      open && open.code !== code ? { code: open.code, label: open.label } : null,
    records,
  };
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
