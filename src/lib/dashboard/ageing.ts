/**
 * Queue ageing and throughput windows — the approver dashboard of spec section 9.
 *
 * Pure, and deliberately so: the bucket boundaries are the one thing on that
 * dashboard that can be wrong without looking wrong. "3–7 days" holding a
 * two-day-old request is invisible on screen and unit-testable here.
 *
 * Boundaries are expressed as absolute cut-off instants computed from the same
 * `Date.now()` basis as `ageInDays`, not as a SQL `now()` interval. That is what
 * lets the aggregate query and the JavaScript helper agree exactly instead of
 * approximately: a request that reads as 3 days old in the list must not land in
 * the 0–2 bucket on the dashboard because the two clocks were read a moment
 * apart.
 */

import { ageInDays } from '@/lib/format';

const DAY_MS = 86_400_000;

export type AgeBucketId = 'FRESH' | 'AGEING' | 'STALE';

export type AgeBucket = {
  id: AgeBucketId;
  label: string;
  /** Inclusive lower bound in whole days. */
  minDays: number;
  /** Inclusive upper bound in whole days; `null` means unbounded. */
  maxDays: number | null;
};

/**
 * Contiguous and exhaustive by construction — every pending request falls in
 * exactly one bucket, so the three counts always sum to the queue depth. A gap
 * between buckets would quietly lose requests from the dashboard while they sat
 * in the queue.
 */
export const AGE_BUCKETS: readonly AgeBucket[] = [
  { id: 'FRESH', label: '0–2 days', minDays: 0, maxDays: 2 },
  { id: 'AGEING', label: '3–7 days', minDays: 3, maxDays: 7 },
  { id: 'STALE', label: '8+ days', minDays: 8, maxDays: null },
];

export function bucketForAge(days: number): AgeBucketId {
  for (const bucket of AGE_BUCKETS) {
    if (days >= bucket.minDays && (bucket.maxDays === null || days <= bucket.maxDays)) {
      return bucket.id;
    }
  }
  // Only reachable for a negative age — a submitted_at in the future, which is
  // clock skew rather than data. Treat it as newly arrived.
  return AGE_BUCKETS[0].id;
}

export function bucketForDate(from: Date | string): AgeBucketId {
  return bucketForAge(ageInDays(from));
}

/**
 * The timestamp window a bucket covers, as `submitted_at` values.
 *
 * Age is a floor of whole days, so "at most `maxDays` old" is "submitted
 * strictly after now − (maxDays + 1) days": a request 7.9 days old still reads
 * as 7. Off by one here would move a week-old request into the 8+ bucket a day
 * early and make the queue look worse than it is.
 */
export function bucketRange(
  bucket: AgeBucket,
  now: number = Date.now(),
): { atOrBefore: Date; after: Date | null } {
  return {
    atOrBefore: new Date(now - bucket.minDays * DAY_MS),
    after: bucket.maxDays === null ? null : new Date(now - (bucket.maxDays + 1) * DAY_MS),
  };
}

export type ThroughputWindowId = 'DAY' | 'WEEK' | 'MONTH';

export type ThroughputWindow = { id: ThroughputWindowId; label: string; days: number };

export const THROUGHPUT_WINDOWS: readonly ThroughputWindow[] = [
  { id: 'DAY', label: 'Last 24 hours', days: 1 },
  { id: 'WEEK', label: 'Last 7 days', days: 7 },
  { id: 'MONTH', label: 'Last 30 days', days: 30 },
];

/** Rolling, not calendar: "last 7 days" must not collapse to a few hours on a Monday morning. */
export function windowStart(days: number, now: number = Date.now()): Date {
  return new Date(now - days * DAY_MS);
}

export function withinWindow(at: Date | string, days: number, now: number = Date.now()): boolean {
  const t = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return t >= windowStart(days, now).getTime() && t <= now;
}

