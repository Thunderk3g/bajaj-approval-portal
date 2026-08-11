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

/**
 * A short caption for a feed row, derived from `notification.type`.
 *
 * Derived rather than mapped, and that is the point: `NOTIFICATION_TYPES` is a
 * TS-only const that grows whenever a new event needs announcing, and a lookup
 * table here would be a second list to keep in step — the failure mode being a
 * new type rendering as a blank caption long after anyone remembers why. The
 * names are already written as readable phrases, so uppercasing the first letter
 * of the snake_case tail is all the formatting they need.
 *
 * `CORRECTION_` is stripped because every row in the feed is about a correction
 * and repeating the word costs the reader the distinction they came for:
 * "Returned by verifier" and "Raised for you" say different things,
 * "Correction returned by verifier" and "Correction raised for you" both start
 * with the same nine characters.
 */
export function notificationLabel(type: string): string {
  const words = type.replace(/^CORRECTION_/, '').replace(/_/g, ' ').trim().toLowerCase();
  if (!words) return '';
  return words[0].toUpperCase() + words.slice(1);
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
