import { and, count, eq, gte } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog } from '@/db/schema';
import type { AuditAction } from '@/lib/audit/actions';

/**
 * Rate limiting counted from the audit log rather than from memory.
 *
 * The limits that matter here guard the cross-scope Apps_No lookup of spec
 * section 7.2 — the one place a sales user may read outside their own SM_ID.
 * An in-process counter would reset on every deploy and would not be shared
 * across instances, so the limit it enforces is whichever is most permissive.
 * Counting the audit rows the action already writes gives a limit that is
 * durable, shared, and impossible to desynchronise from the evidence trail:
 * if the lookup happened, it counts.
 *
 * The cost is one indexed COUNT per attempt, on `audit_log_actor_idx`
 * (actor_id, created_at) — the index that already exists for the audit viewer.
 */

/** Spec section 7.2: 20 cross-scope lookups per sales user per hour. */
export const LOOKUP_LIMIT_PER_HOUR = 20;

export type RateLimitVerdict = {
  allowed: boolean;
  used: number;
  limit: number;
  /** When the window frees up, for the user-facing message. */
  retryAt: Date;
};

export async function checkActionRateLimit(options: {
  actorId: string;
  action: AuditAction;
  limit: number;
  windowMs: number;
}): Promise<RateLimitVerdict> {
  const since = new Date(Date.now() - options.windowMs);

  const [row] = await db
    .select({ used: count() })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorId, options.actorId),
        eq(auditLog.action, options.action),
        gte(auditLog.createdAt, since),
      ),
    );

  const used = row?.used ?? 0;

  return {
    allowed: used < options.limit,
    used,
    limit: options.limit,
    retryAt: new Date(since.getTime() + options.windowMs),
  };
}

/** The section 7.2 lookup limit, pre-applied. */
export function checkLookupRateLimit(actorId: string): Promise<RateLimitVerdict> {
  return checkActionRateLimit({
    actorId,
    action: 'RECORD_LOOKUP',
    limit: LOOKUP_LIMIT_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
}
