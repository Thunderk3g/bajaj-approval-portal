'use server';

import { z } from 'zod';
import { requireSession } from '@/lib/auth/rbac';
import { fail, ok, type ActionResult } from '@/lib/result';
import { markAllRead, markRead } from './queries';

/**
 * The only mutation surface the browser can reach for notifications.
 *
 * Each export re-derives the owning user from the session rather than accepting
 * a user id, because a 'use server' export is a public endpoint: anything in its
 * signature is attacker-controlled. The notification id still arrives from the
 * client, so it is never trusted for anything more than "which row of MINE" —
 * ownership is enforced in the UPDATE's WHERE clause, not here.
 *
 * AuthzError from requireSession is deliberately allowed to propagate: the
 * layout turns it into a redirect, and swallowing it into a `fail` would leave
 * a signed-out user staring at an inline error instead of the login page.
 */

const notificationId = z.uuid();

/**
 * One message for "no such notification" and "not yours".
 *
 * Distinguishing them would tell a caller that some id they guessed exists and
 * belongs to somebody else, which is exactly the fact worth hiding.
 */
const NOT_FOUND = 'That notification is no longer available.';

export async function markNotificationRead(id: string): Promise<ActionResult<void>> {
  const user = await requireSession();

  const parsed = notificationId.safeParse(id);
  if (!parsed.success) return fail(NOT_FOUND);

  const changed = await markRead(user.id, parsed.data);
  if (!changed) return fail(NOT_FOUND);

  return ok();
}

export async function markAllNotificationsRead(): Promise<ActionResult<{ marked: number }>> {
  const user = await requireSession();
  const marked = await markAllRead(user.id);
  return ok({ marked });
}
