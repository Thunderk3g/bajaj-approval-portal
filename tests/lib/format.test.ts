/**
 * Timestamps must not move when the host does.
 *
 * `formatDateTime` renders through `toLocaleString`, which without an explicit
 * `timeZone` uses whatever zone the process runs in: IST on a developer's
 * machine, UTC inside the container, and the difference is 5.5 hours on every
 * audit row, decision time and queue age in the portal. Nothing on screen says
 * which zone it is, so the wrong one is indistinguishable from the right one —
 * the defect only shows up as two people quoting different times for the same
 * approval.
 *
 * This whole file therefore runs under a NON-IST zone. Under IST the assertions
 * below pass whether or not the fix is present, which is the same as not having
 * a test; under New York they fail the moment `timeZone` is dropped.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ageInDays, formatDate, formatDateTime } from '@/lib/format';

const ORIGINAL_TZ = process.env.TZ;

beforeAll(() => {
  // Node reapplies this at assignment time (it notifies V8's date/time
  // configuration), so both Date and Intl pick it up without a reload.
  process.env.TZ = 'America/New_York';
});

afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('formatDateTime pins the business timezone', () => {
  it('is running under a host zone that would give a different answer', () => {
    // The guard on the guard. If this ever reports Asia/*, every assertion
    // below has stopped proving anything.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('America/New_York');
  });

  it('renders a known instant on the Asia/Kolkata clock, not the host clock', () => {
    // 18:45 UTC is 00:15 the NEXT day in IST and 13:45 the SAME day in New
    // York, so this instant catches both the hour and the date rolling.
    expect(formatDateTime(new Date('2026-02-14T18:45:00.000Z'))).toBe('15 Feb 2026, 12:15 am');
  });

  it('gives an ISO string the same reading as the Date it parses to', () => {
    const iso = '2026-08-16T03:30:00.000Z';
    expect(formatDateTime(iso)).toBe('16 Aug 2026, 09:00 am');
    expect(formatDateTime(iso)).toBe(formatDateTime(new Date(iso)));
  });

  it('keeps the +5:30 offset across the half-hour boundary', () => {
    // 23:59 UTC on the last day of a month is the 1st in IST — a month and a
    // year rolling at once, which is where a naive offset shows up.
    expect(formatDateTime(new Date('2026-12-31T23:59:00.000Z'))).toBe('01 Jan 2027, 05:29 am');
  });

  it('still returns the dash for nothing and the input for garbage', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not a date')).toBe('not a date');
  });
});

describe('formatDate is date-only and therefore zone-free', () => {
  it('renders a stored date the same whatever the host zone is', () => {
    // Deliberately not given a timeZone in the source: it parses at midnight
    // UTC and reads the UTC parts back, so there is no local clock involved to
    // pin. Asserted here so a "consistency" edit that routes it through
    // toLocaleString without a zone fails instead of passing quietly.
    expect(formatDate('2026-02-14')).toBe('14 Feb 2026');
    expect(formatDate('2026-12-31')).toBe('31 Dec 2026');
    expect(formatDate(new Date('2026-08-16T00:00:00.000Z'))).toBe('16 Aug 2026');
    expect(formatDate(null)).toBe('—');
  });
});

describe('ageInDays is epoch arithmetic, with no clock to pin', () => {
  it('counts whole days regardless of the host zone', () => {
    expect(ageInDays(new Date(Date.now() - 5 * 86_400_000))).toBe(5);
    // A timestamp from the future is "just arrived", not a negative age.
    expect(ageInDays(new Date(Date.now() + 86_400_000))).toBe(0);
  });
});
