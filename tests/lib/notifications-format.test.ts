import { describe, expect, it } from 'vitest';
import { badgeLabel, bellLabel, relativeTime, BADGE_CAP } from '@/components/notifications/format';

describe('notification badge (spec 10)', () => {
  it('renders nothing at zero — an empty badge is noise, not information', () => {
    expect(badgeLabel(0)).toBeNull();
    expect(badgeLabel(-1)).toBeNull();
    expect(badgeLabel(Number.NaN)).toBeNull();
  });

  it('caps so the badge cannot push the header controls off screen', () => {
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(BADGE_CAP)).toBe('99');
    expect(badgeLabel(BADGE_CAP + 1)).toBe('99+');
    expect(badgeLabel(4000)).toBe('99+');
  });

  it('states the count in text, so the badge is not the only signal', () => {
    expect(bellLabel(0)).toMatch(/none unread/);
    expect(bellLabel(3)).toMatch(/3 unread/);
  });
});

describe('relative time', () => {
  const now = Date.parse('2026-07-27T12:00:00Z');

  it.each([
    ['2026-07-27T11:59:31Z', 'just now'],
    ['2026-07-27T11:45:00Z', '15m ago'],
    ['2026-07-27T09:00:00Z', '3h ago'],
    ['2026-07-25T12:00:00Z', '2d ago'],
  ])('renders %j as %j', (at, expected) => {
    expect(relativeTime(at, now)).toBe(expected);
  });

  it('never dates a row in the future when the server clock runs ahead', () => {
    // A notification written a second from now by a slightly fast server must
    // not read as "in 1 minute", which looks like a bug rather than clock skew.
    expect(relativeTime('2026-07-27T12:00:30Z', now)).toBe('just now');
  });

  it('switches to a date past a week, where "9d ago" stops meaning anything', () => {
    expect(relativeTime('2026-07-01T12:00:00Z', now)).toMatch(/Jul/);
  });

  it('returns empty for an unparseable timestamp instead of NaN', () => {
    expect(relativeTime('not a date', now)).toBe('');
  });
});
