import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { countUnread, recentNotifications } from '@/lib/notifications/queries';

/**
 * The bell's poll target — spec sections 9 and 10.
 *
 * Polling, not a socket: real-time delivery is explicitly out of scope
 * (section 2). A WebSocket would need a second server process, sticky sessions
 * behind the load balancer, and its own auth handshake, to shave under a minute
 * off a notification nobody is watching for.
 *
 * This handler calls requireSession itself. Middleware redirects browsers, but
 * it is not the authorization boundary (section 4.1) — a direct fetch that
 * slipped past it would otherwise read whatever `userId` it asked for.
 */

export const dynamic = 'force-dynamic';

const DEFAULT_ITEMS = 10;
const MAX_ITEMS = 25;

/**
 * This response is one user's inbox. `private, no-store` keeps it out of any
 * shared cache — a CDN or corporate proxy that kept it would hand one rep's
 * notifications to the next person who polled.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

export async function GET(request: Request) {
  let user;
  try {
    user = await requireSession();
  } catch (error) {
    if (error instanceof AuthzError) {
      // 403 for a deactivated account, 401 for no session. Both are terse: the
      // body of an unauthenticated response is not the place to describe state.
      return NextResponse.json(
        { error: error.code },
        { status: error.code === 'UNAUTHENTICATED' ? 401 : 403, headers: NO_STORE },
      );
    }
    throw error;
  }

  const raw = Number(new URL(request.url).searchParams.get('limit'));
  const limit =
    Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_ITEMS) : DEFAULT_ITEMS;

  const [unread, items] = await Promise.all([
    countUnread(user.id),
    recentNotifications(user.id, limit),
  ]);

  return NextResponse.json({ unread, items }, { headers: NO_STORE });
}
