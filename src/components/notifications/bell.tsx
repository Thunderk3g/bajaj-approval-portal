'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { apiPath } from '@/lib/nav';
import { markAllNotificationsRead, markNotificationRead } from '@/lib/notifications/actions';
import { badgeLabel, bellLabel, notificationLabel, relativeTime } from './format';

/**
 * The header bell — spec section 10.
 *
 * Polled, not pushed. Real-time delivery is out of scope (section 2), and the
 * poll is deliberately cheap: `GET /api/notifications` reads a bounded slice of
 * `notification_user_idx` and returns a count plus ten rows.
 *
 * Polling is suspended while the tab is hidden and resumed with an immediate
 * fetch when it comes back. Left running, every abandoned tab in the office
 * would keep a session alive and issue a query a minute for the rest of the
 * day — which is how a fleet of forgotten tabs becomes the largest single
 * source of load on the database.
 */

const POLL_MS = 60_000;

type FeedItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
};

type Feed = { unread: number; items: FeedItem[] };

export function NotificationBell() {
  const router = useRouter();
  const [feed, setFeed] = useState<Feed>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(apiPath('/api/notifications'), {
        signal,
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        // A 401 here means the session expired in another tab. Silently showing
        // a stale count would be worse than showing nothing, so the bell empties
        // and the next navigation lands the user on /login.
        setFeed({ unread: 0, items: [] });
        setFailed(response.status !== 401 && response.status !== 403);
        return;
      }
      setFeed((await response.json()) as Feed);
      setFailed(false);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void load(controller.signal), POLL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void load(controller.signal);
        start();
      } else {
        stop();
      }
    };

    void load(controller.signal);
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      controller.abort();
    };
  }, [load]);

  // Dismissal: a panel that only closes via its own button traps the pointer on
  // touch devices, where there is nowhere obvious to click "off" a dropdown.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function toggle() {
    setOpen((previous) => {
      if (!previous) void load();
      return !previous;
    });
  }

  /**
   * Marks read optimistically, then reconciles from the server.
   *
   * The optimistic step exists because the click usually navigates away at the
   * same moment; waiting for the round trip would leave the badge stale on the
   * page the user just landed on. The action is still authoritative — it scopes
   * the update to the session's own rows, so a wrong guess here corrects itself
   * on the next poll rather than persisting.
   */
  async function openItem(item: FeedItem) {
    setOpen(false);
    if (item.isRead) return;

    setFeed((current) => ({
      unread: Math.max(0, current.unread - 1),
      items: current.items.map((i) => (i.id === item.id ? { ...i, isRead: true } : i)),
    }));

    // A rejected action here is almost always an expired session, which
    // requireSession signals by throwing. Letting it escape would replace the
    // page the user just navigated to with an error boundary; the next poll
    // reports the truth either way.
    try {
      await markNotificationRead(item.id);
    } catch {
      /* fall through to the reload below */
    }
    await load();
  }

  async function markAll() {
    setFeed((current) => ({ unread: 0, items: current.items.map((i) => ({ ...i, isRead: true })) }));
    try {
      await markAllNotificationsRead();
    } catch {
      /* the reload below restores the real state */
    }
    await load();
    router.refresh();
  }

  const badge = badgeLabel(feed.unread);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={bellLabel(feed.unread)}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-[5px] text-[12px] text-slate-800 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
      >
        <span>Notifications</span>
        {/* Inline beside the word, not floated over a glyph. A count that
            overhangs the control clips against the header's sticky edge, and
            the header has room for the word. */}
        {badge ? (
          <span className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-red-700 px-1 text-[10px] font-semibold leading-none text-white tabular-nums">
            {badge}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3.5 py-[9px]">
            <p className="text-[13px] font-semibold text-slate-900">Notifications</p>
            {feed.unread > 0 ? (
              <button
                type="button"
                onClick={() => void markAll()}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              >
                Mark all read
              </button>
            ) : null}
          </div>

          <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
            {failed ? (
              <li className="px-3.5 py-7 text-center text-[13px] text-slate-500">
                Could not load notifications. Retrying shortly.
              </li>
            ) : feed.items.length === 0 ? (
              <li className="px-3.5 py-7 text-center text-[13px] text-slate-500">Nothing yet.</li>
            ) : (
              feed.items.map((item) => (
                <li key={item.id}>
                  <FeedRow item={item} onOpen={() => void openItem(item)} />
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A notification without a link still has to be dismissible, so the row degrades
 * to a button rather than rendering an anchor to nowhere — spec section 10 says
 * notifications link to the relevant request or record, but a row whose target
 * was since deleted must not become a dead end.
 */
function FeedRow({ item, onOpen }: { item: FeedItem; onOpen: () => void }) {
  const body = (
    <span className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className={
          item.isRead
            ? 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-transparent'
            : 'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-700'
        }
      />
      <span className="min-w-0 flex-1">
        <span
          className={
            item.isRead
              ? 'block text-[13px] text-slate-700'
              : 'block text-[13px] font-semibold text-slate-900'
          }
        >
          {item.title}
        </span>
        {item.body ? (
          <span className="mt-0.5 block text-[12px] text-pretty text-slate-500">{item.body}</span>
        ) : null}
        <span className="mt-0.5 block text-[11px] text-slate-400">
          {notificationLabel(item.type)} · {relativeTime(item.createdAt)}
        </span>
      </span>
    </span>
  );

  const className = 'block w-full px-3.5 py-2.5 text-left no-underline hover:bg-slate-50';

  return item.link ? (
    <Link href={item.link} onClick={onOpen} className={className}>
      {body}
    </Link>
  ) : (
    <button type="button" onClick={onOpen} className={className}>
      {body}
    </button>
  );
}

