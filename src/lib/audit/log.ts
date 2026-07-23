import { db } from '@/db/client';
import { auditLog } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import type { AuditAction } from './actions';

/**
 * The transaction handle Drizzle hands to `db.transaction(async (tx) => ...)`.
 *
 * Derived from `db` rather than spelled out as
 * `PgTransaction<NodePgQueryResultHKT, typeof schema, ...>`: the explicit form
 * has to be kept in step with the driver and the schema by hand, and it is
 * wrong the moment either changes. Deriving it means the type is whatever
 * `db.transaction` actually passes, by construction.
 */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Either the pooled database or an open transaction — both can insert. */
export type AuditExecutor = typeof db | DbTransaction;

export type AuditInput = {
  /** `null` for system-originated actions (jobs, migrations, unauthenticated failures). */
  actor: Pick<SessionUser, 'id' | 'email' | 'role'> | null;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Appends one row to the audit trail.
 *
 * The actor's email and role are copied onto the row rather than left to a join
 * against `user`. Two reasons: the FK nulls `actorId` out when an account is
 * deleted, and a role is a point-in-time fact — someone who was `sales` when
 * they submitted a correction may be `approver` a year later, and the trail has
 * to say what they were at the time, not what they are now.
 *
 * Pass `tx` to enlist the write in a caller's transaction so the audit row
 * commits or rolls back atomically with the change it describes. Without it,
 * a failure after the audit write leaves a record of something that never
 * happened; worse, a failure before it leaves a change nobody logged.
 *
 * Errors are deliberately not swallowed. An audit write that fails silently is
 * indistinguishable from an action that was never taken.
 */
export async function writeAudit(input: AuditInput, tx?: DbTransaction): Promise<void> {
  const executor: AuditExecutor = tx ?? db;

  await executor.insert(auditLog).values({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    actorRole: input.actor?.role ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}
