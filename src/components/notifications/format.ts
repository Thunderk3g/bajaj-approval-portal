/**
 * Pure presentation helpers for the notification bell.
 *
 * Split out of bell.tsx so they can be tested without a DOM or a React
 * renderer — the interesting cases here are boundaries (zero, the badge cap,
 * a timestamp that has just crossed a minute), not markup.
 */

export const BADGE_CAP = 99;

/**
 * An unbounded count would widen the badge until it pushed the sign-out button
 * off the header. Past the cap the exact number tells the user nothing they
 * would act on differently.
 */
export function badgeLabel(unread: number): string | null {
  if (!Number.isFinite(unread) || unread <= 0) return null;
  return unread > BADGE_CAP ? `${BADGE_CAP}+` : String(Math.floor(unread));
}

/** Screen-reader text for the bell, so the badge is not the only signal. */
export function bellLabel(unread: number): string {
  if (unread <= 0) return 'Notifications, none unread';
  return `Notifications, ${unread} unread`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse relative time for the feed.
 *
 * Rounds down, and never says "in 3 minutes": a row created by a server whose
 * clock runs slightly ahead of the browser's would otherwise be dated in the
 * future, which reads as a bug rather than as clock skew.
 */
export function relativeTime(value: Date | string, now: number = Date.now()): string {
  const at = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(at)) return '';

  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;

  const d = value instanceof Date ? value : new Date(at);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}
