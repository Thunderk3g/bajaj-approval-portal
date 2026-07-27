import { and, asc, count, desc, eq, gte, ilike, lt, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog } from '@/db/schema';
import { AUDIT_ACTIONS, type AuditAction } from '@/lib/audit/actions';

/**
 * Reads for the audit viewer — spec sections 5.9 and 4.6.
 *
 * There is no write path in this module and there is not going to be one.
 * `audit_log` is append-only, enforced by a BEFORE UPDATE OR DELETE trigger, so
 * an "edit" here would not fail politely at the UI — it would raise from the
 * database mid-request. Rows are inserted through writeAudit and by nothing
 * else.
 *
 * Actor email and role are selected straight off the row and never joined back
 * to `user`. That denormalization is the whole point of section 4.6: if the
 * viewer resolved the actor at read time, renaming a user or changing their role
 * would silently rewrite every historical line they ever appear on.
 */

export type AuditRow = {
  id: number;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  metadata: unknown;
  ipAddress: string | null;
  createdAt: Date;
};

export type AuditFilters = {
  action?: string | null;
  actor?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  from?: string | null;
  to?: string | null;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * A date-only bound is read as UTC and the upper bound is exclusive of the
 * following day.
 *
 * Timestamps are `timestamptz`, so "13 July" only means something once a zone is
 * named. Fixing it to UTC makes the same filter select the same rows no matter
 * which machine renders the page; letting it drift with the server's local zone
 * would make an audit query irreproducible, which defeats the purpose of one.
 */
function dayStartUtc(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function nextDayUtc(value: string): Date {
  const start = dayStartUtc(value);
  return new Date(start.getTime() + 86_400_000);
}

/**
 * Builds the WHERE clause, ignoring anything that does not parse.
 *
 * An unrecognised action or a malformed date is dropped rather than rejected:
 * these arrive from a hand-editable query string, and the honest response to
 * `?action=nonsense` is the unfiltered page, not an error screen.
 */
export function auditConditions(filters: AuditFilters): SQL | undefined {
  const parts: SQL[] = [];

  const action = filters.action?.trim();
  if (action && isAuditAction(action)) parts.push(eq(auditLog.action, action));

  const actor = filters.actor?.trim();
  // Matched against the recorded email on the row, not against `user`.
  if (actor) parts.push(ilike(auditLog.actorEmail, `%${actor}%`));

  const entityType = filters.entityType?.trim();
  if (entityType) parts.push(eq(auditLog.entityType, entityType));

  const entityId = filters.entityId?.trim();
  if (entityId) parts.push(eq(auditLog.entityId, entityId));

  const from = filters.from?.trim();
  if (from && DATE_ONLY.test(from)) parts.push(gte(auditLog.createdAt, dayStartUtc(from)));

  const to = filters.to?.trim();
  if (to && DATE_ONLY.test(to)) parts.push(lt(auditLog.createdAt, nextDayUtc(to)));

  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : and(...parts);
}

export async function listAuditLog(
  filters: AuditFilters,
  page: { limit: number; offset: number },
): Promise<{ rows: AuditRow[]; total: number }> {
  const where = auditConditions(filters);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        actorId: auditLog.actorId,
        actorEmail: auditLog.actorEmail,
        actorRole: auditLog.actorRole,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        before: auditLog.before,
        after: auditLog.after,
        metadata: auditLog.metadata,
        ipAddress: auditLog.ipAddress,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(where)
      // Newest first, and `id` breaks the tie: two rows written inside one
      // transaction share a created_at to the microsecond, and an unstable sort
      // would shuffle them between page loads.
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(page.limit)
      .offset(page.offset),
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  return { rows, total: totals?.value ?? 0 };
}

/** Entity types actually present, so the filter offers only what exists. */
export async function distinctEntityTypes(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ entityType: auditLog.entityType })
    .from(auditLog)
    .orderBy(asc(auditLog.entityType));
  return rows.map((r) => r.entityType);
}
