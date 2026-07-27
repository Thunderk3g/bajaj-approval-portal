import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { notification } from '@/db/schema';

/**
 * The read side of notifications — spec sections 10 and 5.10.
 *
 * Every function here takes `userId` as its first argument and there is no
 * overload that omits it. That parameter is the entire access control story for
 * this table: a notification carries the title and deep link of a correction
 * request, so serving one to the wrong account leaks another rep's book. The
 * value is supplied by the Server Action / Route Handler layer from the
 * session, never from a form field or a query string — see ./actions.ts.
 *
 * The mark-read mutations live here rather than in actions.ts for the same
 * reason. A 'use server' module exports callable endpoints; an exported
 * `markRead(userId, id)` would let a browser pass any user id it liked. Keeping
 * the userId-taking form unexported from the action boundary makes that
 * impossible by construction.
 *
 * Ordering follows `notification_user_idx` — (user_id, is_read, created_at DESC)
 * — so the polled queries are index scans rather than sorts.
 */

export type NotificationRow = {
  id: string;
  /** One of NOTIFICATION_TYPES, but typed as text: the column has no enum
   *  behind it, so narrowing here would assert a guarantee nothing enforces. */
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: Date;
};

const COLUMNS = {
  id: notification.id,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  link: notification.link,
  isRead: notification.isRead,
  createdAt: notification.createdAt,
};

/** Badge count for the header bell. */
export async function countUnread(userId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.isRead, false)));
  return row?.value ?? 0;
}

/**
 * The bell dropdown's feed: unread first, newest within each group.
 *
 * That sort order is not a preference — it is exactly the index's own order, so
 * the query the browser repeats every minute reads a bounded slice of the index
 * and never sorts. Newest-first alone would push an unread item below a wall of
 * already-read ones, which is the opposite of what a bell is for.
 */
export async function recentNotifications(userId: string, limit = 10): Promise<NotificationRow[]> {
  return db
    .select(COLUMNS)
    .from(notification)
    .where(eq(notification.userId, userId))
    .orderBy(asc(notification.isRead), desc(notification.createdAt))
    .limit(limit);
}

export type ListOptions = {
  limit: number;
  offset: number;
  unreadOnly?: boolean;
};

/** Paginated history, newest first, with the total for the pager. */
export async function listNotifications(
  userId: string,
  { limit, offset, unreadOnly = false }: ListOptions,
): Promise<{ rows: NotificationRow[]; total: number }> {
  const where = unreadOnly
    ? and(eq(notification.userId, userId), eq(notification.isRead, false))
    : eq(notification.userId, userId);

  const [rows, [totals]] = await Promise.all([
    db
      .select(COLUMNS)
      .from(notification)
      .where(where)
      .orderBy(desc(notification.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ value: count() }).from(notification).where(where),
  ]);

  return { rows, total: totals?.value ?? 0 };
}

/**
 * Marks one notification read, scoped to its owner in the WHERE clause.
 *
 * The ownership check is part of the UPDATE rather than a preceding SELECT.
 * A read-then-write would be a TOCTOU gap, and more importantly a separate
 * existence check invites the caller to report "not yours" differently from
 * "not found" — which turns this into an oracle for whether a given
 * notification id exists at all.
 *
 * Returns false when nothing matched, which covers both cases identically.
 *
 * `read_at` is coalesced rather than overwritten so a second click — the bell
 * fires this on every open of an item — cannot rewrite when the user first saw
 * it, while the call stays idempotent instead of reporting "not found" the
 * second time.
 */
export async function markRead(userId: string, notificationId: string): Promise<boolean> {
  const updated = await db
    .update(notification)
    .set({ isRead: true, readAt: sql`coalesce(${notification.readAt}, now())` })
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId)))
    .returning({ id: notification.id });

  return updated.length > 0;
}

/** Marks every unread notification of one user read. Returns how many changed. */
export async function markAllRead(userId: string): Promise<number> {
  const updated = await db
    .update(notification)
    .set({ isRead: true, readAt: new Date() })
    .where(and(eq(notification.userId, userId), eq(notification.isRead, false)))
    .returning({ id: notification.id });

  return updated.length;
}
