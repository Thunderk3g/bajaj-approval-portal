/**
 * Approver dashboard aggregates — spec section 9: queue depth, ageing, throughput.
 *
 * Throughput is read from `correction_event`, never from `correction_request`.
 * A returned request that is resubmitted goes back to PENDING (section 7), so
 * the request's own status forgets the decision that was made on it; the event
 * timeline does not. Counting decisions from request rows would quietly
 * under-report exactly the work that generated the most of it.
 */

import { eq, gt, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionEvent, correctionRequest } from '@/db/schema';
import {
  AGE_BUCKETS,
  THROUGHPUT_WINDOWS,
  bucketRange,
  windowStart,
  type AgeBucketId,
  type ThroughputWindowId,
} from './ageing';
import { countAll, countFiltered } from './sql';

/**
 * The three `event_action` values that represent an approver decision.
 *
 * SUBMITTED, RESUBMITTED and WITHDRAWN are the rep's actions, not the
 * approver's — counting them as throughput would credit the queue with work it
 * did not do.
 */
export const DECISION_ACTIONS = ['APPROVED', 'REJECTED', 'RETURNED'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export type ApproverDashboard = {
  queue: {
    /** VERIFIED — waiting on an approver. This is the approver's own depth. */
    pending: number;
    /**
     * PENDING — waiting on a VERIFIER, upstream of this dashboard.
     *
     * Shown because it is the leading indicator: an approver whose own queue is
     * empty while this number climbs is not idle, they are blocked, and nothing
     * else on the page would tell them apart.
     */
    awaitingVerification: number;
    /** Waiting on the rep to resubmit — not queue depth, but not closed either. */
    returned: number;
    oldestPendingAt: Date | null;
    ageing: Record<AgeBucketId, number>;
  };
  throughput: Record<ThroughputWindowId, Record<DecisionAction | 'TOTAL', number>>;
};

/** `and(...)` returns `SQL | undefined`; every predicate here is known present. */
function allOf(...parts: SQL[]): SQL {
  return sql`(${sql.join(parts, sql` and `)})`;
}

export async function getApproverDashboard(now: number = Date.now()): Promise<ApproverDashboard> {
  // The approver's queue is VERIFIED, not PENDING, since the 2026-07-28 gate.
  // The local name is kept so the ageing buckets below read the same as before;
  // what changed is which status they measure.
  const isPending = eq(correctionRequest.status, 'VERIFIED');

  // Bucket boundaries are absolute instants derived from one clock reading, not
  // from SQL now(). Two reads of now() inside one query would still agree, but
  // the JS helper that renders "oldest pending: 9 days" would not, and a request
  // reported as 8 days old must not be counted in the 3–7 bucket.
  const ageingSelection: Record<string, SQL<number>> = {};
  for (const bucket of AGE_BUCKETS) {
    const { atOrBefore, after } = bucketRange(bucket, now);
    const parts: SQL[] = [isPending, lte(correctionRequest.submittedAt, atOrBefore)];
    if (after) parts.push(gt(correctionRequest.submittedAt, after));
    ageingSelection[bucket.id] = countFiltered(allOf(...parts));
  }

  const throughputSelection: Record<string, SQL<number>> = {};
  for (const window of THROUGHPUT_WINDOWS) {
    const since = windowStart(window.days, now);
    const inWindow = sql`${correctionEvent.createdAt} >= ${since}`;
    for (const action of DECISION_ACTIONS) {
      throughputSelection[`${window.id}_${action}`] = countFiltered(
        allOf(inWindow, eq(correctionEvent.action, action)),
      );
    }
    throughputSelection[`${window.id}_TOTAL`] = countFiltered(
      allOf(inWindow, inArray(correctionEvent.action, [...DECISION_ACTIONS])),
    );
  }

  const [queue, ageing, throughput] = await Promise.all([
    db
      .select({
        total: countAll,
        pending: countFiltered(isPending),
        awaitingVerification: countFiltered(eq(correctionRequest.status, 'PENDING')),
        returned: countFiltered(eq(correctionRequest.status, 'RETURNED')),
        // mapWith: drizzle's node-postgres driver leaves timestamps as raw
        // strings for the column codec to parse, so an unmapped aggregate would
        // hand `ageInDays` a string instead of the Date it expects.
        oldestPendingAt: sql<Date | null>`min(${correctionRequest.submittedAt}) filter (where ${isPending})`.mapWith(
          correctionRequest.submittedAt,
        ),
      })
      .from(correctionRequest),

    db.select(ageingSelection).from(correctionRequest),

    db.select(throughputSelection).from(correctionEvent),
  ]);

  const ageingRow = ageing[0];
  const throughputRow = throughput[0];

  return {
    queue: {
      pending: queue[0].pending,
      awaitingVerification: queue[0].awaitingVerification,
      returned: queue[0].returned,
      oldestPendingAt: queue[0].oldestPendingAt,
      ageing: Object.fromEntries(
        AGE_BUCKETS.map((bucket) => [bucket.id, ageingRow[bucket.id] ?? 0]),
      ) as Record<AgeBucketId, number>,
    },
    throughput: Object.fromEntries(
      THROUGHPUT_WINDOWS.map((window) => [
        window.id,
        {
          APPROVED: throughputRow[`${window.id}_APPROVED`] ?? 0,
          REJECTED: throughputRow[`${window.id}_REJECTED`] ?? 0,
          RETURNED: throughputRow[`${window.id}_RETURNED`] ?? 0,
          TOTAL: throughputRow[`${window.id}_TOTAL`] ?? 0,
        },
      ]),
    ) as Record<ThroughputWindowId, Record<DecisionAction | 'TOTAL', number>>,
  };
}
