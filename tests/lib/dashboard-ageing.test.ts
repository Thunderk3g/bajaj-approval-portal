import { describe, expect, it } from 'vitest';
import {
  AGE_BUCKETS,
  THROUGHPUT_WINDOWS,
  bucketForAge,
  bucketForDate,
  bucketRange,
  windowStart,
  withinWindow,
} from '@/lib/dashboard/ageing';
import { ageInDays } from '@/lib/format';

const DAY = 86_400_000;
const NOW = Date.parse('2026-07-27T12:00:00.000Z');

describe('queue ageing buckets (spec 9)', () => {
  it.each([
    [0, 'FRESH'],
    [1, 'FRESH'],
    [2, 'FRESH'],
    [3, 'AGEING'],
    [5, 'AGEING'],
    [7, 'AGEING'],
    [8, 'STALE'],
    [90, 'STALE'],
  ])('puts a %i-day-old request in %s', (days, expected) => {
    expect(bucketForAge(days)).toBe(expected);
  });

  it('assigns every age to exactly one bucket', () => {
    // A gap between bands would lose requests from the dashboard while they sat
    // in the queue, and an overlap would double-count them against the depth.
    for (let days = 0; days <= 60; days += 1) {
      const matches = AGE_BUCKETS.filter(
        (b) => days >= b.minDays && (b.maxDays === null || days <= b.maxDays),
      );
      expect(matches, `age ${days}`).toHaveLength(1);
    }
  });

  it('treats a future timestamp as newly arrived rather than falling through', () => {
    expect(bucketForAge(-1)).toBe('FRESH');
  });

  it('agrees with ageInDays on a real timestamp', () => {
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    expect(ageInDays(fiveDaysAgo)).toBe(5);
    expect(bucketForDate(fiveDaysAgo)).toBe('AGEING');
    expect(bucketForDate(new Date(Date.now() - 20 * DAY))).toBe('STALE');
  });
});

describe('bucket ranges are the SQL form of the same boundaries', () => {
  const contains = (range: { atOrBefore: Date; after: Date | null }, at: number) =>
    at <= range.atOrBefore.getTime() && (range.after === null || at > range.after.getTime());

  it('keeps a request that reads as 7 days old out of the 8+ band', () => {
    // Age is a floor of whole days, so 7.9 days still renders as 7. An upper
    // bound of "now - 7 days" would move it a full day early.
    const at = NOW - 7.9 * DAY;
    const ageing = AGE_BUCKETS.find((b) => b.id === 'AGEING')!;
    const stale = AGE_BUCKETS.find((b) => b.id === 'STALE')!;

    expect(contains(bucketRange(ageing, NOW), at)).toBe(true);
    expect(contains(bucketRange(stale, NOW), at)).toBe(false);
  });

  it('matches bucketForAge for every offset, so the count and the list agree', () => {
    // Both sides are measured from the same NOW. Reading one from `Date.now()`
    // and the other from a fixed instant is exactly the skew these ranges exist
    // to remove, and it would make this assertion pass or fail by the hour.
    for (const offset of [0, 0.5, 1, 2.99, 3, 6.5, 7.5, 8, 8.01, 40]) {
      const at = NOW - offset * DAY;
      const expected = bucketForAge(Math.floor((NOW - at) / DAY));
      const matching = AGE_BUCKETS.filter((b) => contains(bucketRange(b, NOW), at));
      expect(matching.map((b) => b.id), `offset ${offset}`).toEqual([expected]);
    }
  });
});

describe('throughput windows (spec 9)', () => {
  it('is rolling, not calendar', () => {
    // "Last 7 days" on a Monday morning must not collapse to a few hours.
    expect(windowStart(7, NOW).getTime()).toBe(NOW - 7 * DAY);
  });

  it('includes a decision just inside the window and excludes one just outside', () => {
    expect(withinWindow(new Date(NOW - 6.9 * DAY), 7, NOW)).toBe(true);
    expect(withinWindow(new Date(NOW - 7.1 * DAY), 7, NOW)).toBe(false);
  });

  it('excludes a timestamp in the future', () => {
    expect(withinWindow(new Date(NOW + DAY), 30, NOW)).toBe(false);
  });

  it('nests: anything in the day window is also in the week and month windows', () => {
    const at = new Date(NOW - 3 * 3600_000);
    for (const window of THROUGHPUT_WINDOWS) {
      expect(withinWindow(at, window.days, NOW), window.id).toBe(true);
    }
  });
});
