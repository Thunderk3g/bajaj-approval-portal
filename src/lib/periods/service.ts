import { and, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, period, salesRecord } from '@/db/schema';
import { writeAudit, type DbTransaction } from '@/lib/audit/log';
import type { SessionUser } from '@/lib/auth/rbac';

/**
 * The monthly cycle — 2026-07-28 spec section 4.
 *
 * A period is a CALENDAR MONTH, not a rolling 30-day window. A rolling window
 * has no stable boundary, so two reports run a day apart cover different data
 * and "which month does this gap belong to" has no answer. A monthly tracker
 * that cannot reconcile against last month's copy of itself is not a tracker.
 *
 * There is no scheduler anywhere in this module. Closing happens when next
 * month's workbook is committed, which is the act that actually starts the new
 * month — a cron would add a container, a failure mode, and a transition that
 * fires when nobody is looking.
 */

export class PeriodClosedError extends Error {
  constructor(
    readonly periodLabel: string,
    message: string,
  ) {
    super(message);
    this.name = 'PeriodClosedError';
  }
}

export class PeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodError';
  }
}

export type PeriodRow = typeof period.$inferSelect;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const CODE_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * `YYYY-MM` from a date.
 *
 * Built from UTC components, not local ones. The server's timezone must not
 * decide which month a period belongs to: on IST a `new Date()` at 05:00 UTC on
 * the 1st is already the new month locally while a UTC read says otherwise, and
 * a boundary that moves with the deployment host is a boundary nobody can
 * reconcile against.
 */
export function periodCodeFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function isPeriodCode(code: string): boolean {
  return CODE_PATTERN.test(code);
}

/** `Jul 2026` — the human form, stored so an export and a screen agree. */
export function periodLabelFor(code: string): string {
  const match = CODE_PATTERN.exec(code);
  if (!match) throw new PeriodError(`"${code}" is not a period code (expected YYYY-MM).`);
  return `${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** First and last day of the month, inclusive, as `YYYY-MM-DD`. */
export function periodBounds(code: string): { startsOn: string; endsOn: string } {
  const match = CODE_PATTERN.exec(code);
  if (!match) throw new PeriodError(`"${code}" is not a period code (expected YYYY-MM).`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  // Day 0 of the NEXT month is the last day of this one, which handles February
  // and leap years without a table.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    startsOn: `${match[1]}-${match[2]}-01`,
    endsOn: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, '0')}`,
  };
}

/* ------------------------------------------------------------------ reads */

export async function currentPeriod(tx?: DbTransaction): Promise<PeriodRow | null> {
  const executor = tx ?? db;
  const [row] = await executor
    .select()
    .from(period)
    .where(eq(period.status, 'OPEN'))
    .limit(1);
  return row ?? null;
}

export async function periodByCode(code: string, tx?: DbTransaction): Promise<PeriodRow | null> {
  const executor = tx ?? db;
  const [row] = await executor.select().from(period).where(eq(period.code, code)).limit(1);
  return row ?? null;
}

/**
 * Which period a correction against this record belongs to.
 *
 * The RECORD's period, not the currently open one. A record still sitting in
 * June's cycle is June's work, and the question the close asks is whether JUNE
 * is closed. Taking the open period instead would let a rep raise July claims
 * against records that were never in July's file, and those claims would then
 * survive July's close for no reason anyone could explain.
 */
export function periodForRecord(record: { periodId: string | null }): string | null {
  return record.periodId;
}

/**
 * Throws if the given period is closed. A null period passes.
 *
 * Null means "raised before the portal tracked periods", not "in some period
 * that might be closed" — so records imported before this feature shipped stay
 * correctable rather than being frozen by a cycle they were never part of.
 */
export async function assertPeriodOpen(periodId: string | null, tx?: DbTransaction): Promise<void> {
  if (!periodId) return;

  const executor = tx ?? db;
  const [row] = await executor
    .select({ status: period.status, label: period.label })
    .from(period)
    .where(eq(period.id, periodId))
    .limit(1);

  if (!row || row.status === 'OPEN') return;

  throw new PeriodClosedError(
    row.label,
    `${row.label} is closed, so no new corrections can be raised against its records. Requests already open in ${row.label} can still be completed.`,
  );
}

/* ----------------------------------------------------------------- writes */

/**
 * Finds or creates the period for a code, opening it if it is new.
 *
 * `onConflictDoNothing` then re-select rather than a check-then-insert: two
 * admins uploading at the same moment would both pass a prior existence check
 * and the second would hit the unique constraint on `code`.
 *
 * A NEW period is created OPEN, which can collide with `period_one_open` if
 * another is already open. That collision is not an error to swallow — it is the
 * signal that the caller must close the older one first, which is exactly what
 * `openPeriodForCommit` below does in the right order.
 */
export async function getOrCreatePeriod(
  code: string,
  actorId: string | null,
  tx?: DbTransaction,
): Promise<PeriodRow> {
  if (!isPeriodCode(code)) {
    throw new PeriodError(`"${code}" is not a period code (expected YYYY-MM).`);
  }

  const executor = tx ?? db;
  const existing = await periodByCode(code, tx);
  if (existing) return existing;

  const bounds = periodBounds(code);

  await executor
    .insert(period)
    .values({
      code,
      label: periodLabelFor(code),
      startsOn: bounds.startsOn,
      endsOn: bounds.endsOn,
      status: 'OPEN',
      openedBy: actorId,
    })
    .onConflictDoNothing({ target: period.code });

  const created = await periodByCode(code, tx);
  if (!created) throw new PeriodError(`Could not create period ${code}.`);
  return created;
}

/**
 * Closes every OPEN period older than `code`, then opens (or reuses) `code`.
 *
 * The order matters and is the whole reason this is one function rather than two
 * calls a caller sequences: `period_one_open` admits exactly one OPEN row, so
 * opening before closing fails on the unique index. Closing first also means a
 * crash between the two leaves zero open periods — recoverable, and visible on
 * the admin screen — rather than two, which is silently wrong.
 *
 * Called from the commit transaction, so a rolled-back import does not leave
 * last month closed and this month never started.
 *
 * `reopenClosed` is the ONE way a closed month reopens from an import, and it
 * defaults to false on purpose: that default is what stops a stale file quietly
 * undoing a reconciliation everybody signed off on. The caller has to have been
 * shown the month, been told it is closed, and pressed a second button — see
 * `commitBatchAction`.
 */
export async function openPeriodForCommit(
  tx: DbTransaction,
  code: string,
  actor: SessionUser,
  options: { reopenClosed?: boolean } = {},
): Promise<{ opened: PeriodRow; closed: PeriodRow[] }> {
  if (!isPeriodCode(code)) {
    throw new PeriodError(`"${code}" is not a period code (expected YYYY-MM).`);
  }

  const closed: PeriodRow[] = [];

  /** Closes one open period and records why, so both callers below read alike. */
  const close = async (row: PeriodRow, reason: string) => {
    const [updated] = await tx
      .update(period)
      .set({ status: 'CLOSED', closedBy: actor.id, closedAt: new Date() })
      .where(eq(period.id, row.id))
      .returning();

    closed.push(updated);

    await writeAudit(
      {
        actor,
        action: 'PERIOD_CLOSE',
        entityType: 'period',
        entityId: row.id,
        before: { status: 'OPEN' },
        after: { status: 'CLOSED' },
        metadata: { code: row.code, label: row.label, reason },
      },
      tx,
    );
  };

  const stale = await tx
    .select()
    .from(period)
    .where(and(eq(period.status, 'OPEN'), lt(period.code, code)));

  for (const row of stale) {
    await close(row, `Superseded by a batch committed into ${code}`);
  }

  const existing = await periodByCode(code, tx);
  if (existing) {
    // A back-dated upload into an already-closed month reopens nothing by
    // itself. Closing is a decision an admin made; an import must not quietly
    // undo it, or a stale file would reopen a reconciled month by accident.
    if (existing.status === 'CLOSED') {
      const refusal = `${existing.label} is closed. Reopen it from Periods before importing a file for that month.`;
      if (!options.reopenClosed) throw new PeriodError(refusal);

      // The override is an administrator's call. `commitBatchAction` already
      // refuses anybody else, but this function is reachable from any commit
      // path and the rule belongs where the reopening actually happens.
      if (actor.role !== 'admin') {
        throw new PeriodError(`${refusal} Only an administrator can reopen a closed period.`);
      }

      /*
       * Whatever is open now closes first — `period_one_open` admits exactly one
       * OPEN row, so the reverse order is a constraint violation rather than a
       * wrong answer. The loop above only caught periods OLDER than this one;
       * reopening a back-dated month means the NEWER open month has to go, and
       * it is named in `closed` so the commit outcome can say which.
       */
      const others = await tx
        .select()
        .from(period)
        .where(and(eq(period.status, 'OPEN'), ne(period.id, existing.id)));

      for (const row of others) {
        await close(row, `Closed so ${existing.label} could be reopened for an import`);
      }

      const [reopened] = await tx
        .update(period)
        .set({ status: 'OPEN', closedBy: null, closedAt: null })
        .where(eq(period.id, existing.id))
        .returning();

      await writeAudit(
        {
          actor,
          action: 'PERIOD_REOPEN_IMPORT',
          entityType: 'period',
          entityId: existing.id,
          before: { status: 'CLOSED', closedBy: existing.closedBy, closedAt: existing.closedAt },
          after: { status: 'OPEN' },
          metadata: {
            code: existing.code,
            label: existing.label,
            reason: 'Reopened by an administrator committing a file into a closed month',
            closedToReopen: others.map((row) => row.code),
          },
        },
        tx,
      );

      return { opened: reopened, closed };
    }
    return { opened: existing, closed };
  }

  const opened = await getOrCreatePeriod(code, actor.id, tx);

  await writeAudit(
    {
      actor,
      action: 'PERIOD_OPEN',
      entityType: 'period',
      entityId: opened.id,
      after: { code: opened.code, label: opened.label, status: 'OPEN' },
      metadata: { openedBy: 'batch commit' },
    },
    tx,
  );

  return { opened, closed };
}

export type CloseOutcome = {
  period: PeriodRow;
  /** Requests still in flight when the close happened — reported, never blocking. */
  openRequests: number;
};

/**
 * Closes a period by hand.
 *
 * Open requests are counted and reported, NOT blocked. A close that any one
 * unreviewed request can veto is a close that will not happen, and the monthly
 * upload would stall behind it. The requests themselves keep working: only NEW
 * claims are refused after this point.
 */
export async function closePeriod(
  periodId: string,
  actor: SessionUser,
): Promise<CloseOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(period)
      .where(eq(period.id, periodId))
      .limit(1)
      .for('update');

    if (!row) throw new PeriodError('That period no longer exists.');
    if (row.status === 'CLOSED') {
      throw new PeriodError(`${row.label} is already closed.`);
    }

    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(correctionRequest)
      .where(
        and(
          eq(correctionRequest.periodId, periodId),
          sql`${correctionRequest.status} in ('PENDING','VERIFIED','RETURNED')`,
        ),
      );

    const [updated] = await tx
      .update(period)
      .set({ status: 'CLOSED', closedBy: actor.id, closedAt: new Date() })
      .where(eq(period.id, periodId))
      .returning();

    await writeAudit(
      {
        actor,
        action: 'PERIOD_CLOSE',
        entityType: 'period',
        entityId: periodId,
        before: { status: 'OPEN' },
        after: { status: 'CLOSED' },
        metadata: {
          code: row.code,
          label: row.label,
          openRequestsAtClose: counted?.total ?? 0,
          reason: 'Closed manually by an administrator',
        },
      },
      tx,
    );

    return { period: updated, openRequests: counted?.total ?? 0 };
  });
}

/**
 * Reopens a closed period.
 *
 * Needed because closing is irreversible from the rep's side — a month closed a
 * day early leaves real corrections unraisable with no way back — and because a
 * back-dated import into a closed month refuses rather than reopening silently.
 *
 * Refuses when another period is already open. `period_one_open` would reject
 * the write anyway; catching it here turns a constraint violation into a
 * sentence naming the period that has to be closed first.
 */
export async function reopenPeriod(periodId: string, actor: SessionUser): Promise<PeriodRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(period)
      .where(eq(period.id, periodId))
      .limit(1)
      .for('update');

    if (!row) throw new PeriodError('That period no longer exists.');
    if (row.status === 'OPEN') return row;

    const [other] = await tx
      .select({ label: period.label })
      .from(period)
      .where(and(eq(period.status, 'OPEN'), ne(period.id, periodId)))
      .limit(1);

    if (other) {
      throw new PeriodError(
        `${other.label} is currently open. Only one period is open at a time — close it before reopening ${row.label}.`,
      );
    }

    const [updated] = await tx
      .update(period)
      .set({ status: 'OPEN', closedBy: null, closedAt: null })
      .where(eq(period.id, periodId))
      .returning();

    await writeAudit(
      {
        actor,
        action: 'PERIOD_OPEN',
        entityType: 'period',
        entityId: periodId,
        before: { status: 'CLOSED', closedAt: row.closedAt },
        after: { status: 'OPEN' },
        metadata: { code: row.code, label: row.label, reason: 'Reopened by an administrator' },
      },
      tx,
    );

    return updated;
  });
}

/** Stamps every record a batch touched with that batch's period. */
export async function stampRecordPeriod(
  tx: DbTransaction,
  recordIds: string[],
  periodId: string,
): Promise<void> {
  if (recordIds.length === 0) return;

  // Chunked: Postgres caps a statement at 65535 bind parameters, and a full
  // monthly import is well over a thousand ids.
  //
  // `inArray`, not `sql\`id = any(${slice})\``. Drizzle's template tag expands a
  // JS array into one placeholder per element, so the `any()` form produces
  // `any(($1, $2, ...))` — a row constructor, not an array — and Postgres
  // rejects it. The helper emits a single array parameter.
  for (let i = 0; i < recordIds.length; i += 1000) {
    const slice = recordIds.slice(i, i + 1000);
    await tx.update(salesRecord).set({ periodId }).where(inArray(salesRecord.id, slice));
  }
}
