/**
 * Admin dashboard aggregates — spec section 9.
 *
 * Five aggregate round trips, issued together. Every figure on the page is a
 * `count(*) filter (...)` rather than a row fetch: the master table accumulates
 * across monthly uploads (section 6.7), so "count the rows in JavaScript" gets
 * slower every month for a number that Postgres already knows.
 *
 * Nothing here imports the record-listing or correction modules. The dashboard
 * needs totals, not rows, and coupling it to a list query would drag paging,
 * sorting and search into a screen that uses none of them.
 */

import { desc, eq, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, correctionRequest, salesRecord, uploadBatch, uploadBatchRow } from '@/db/schema';
import type { GapType } from '@/lib/records/gaps';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';
import {
  ANOMALY_CONDITION,
  ANY_GAP_CONDITION,
  ISSUED_CONDITION,
  countAll,
  countDistinctFiltered,
  countFiltered,
  gapCondition,
} from './sql';

/** How many audit rows the activity panel shows. Enough to see a session's work, not a log viewer. */
const ACTIVITY_LIMIT = 8;

/**
 * Gapped rows that belong to a person — the denominator of "reps to chase".
 *
 * `count(distinct sm_id)` over the login dump counts `DIY` and `111222-UN` as
 * two more reps, and the tile reads as a headcount an admin can go and talk to.
 * Nobody can be chased for the digital channel's paperwork.
 */
const REP_GAP_CONDITION = sql`(${ANY_GAP_CONDITION} and ${notInArray(salesRecord.smId, PLACEHOLDER_CODE_LIST)})`;

export type ActivityEntry = {
  id: number;
  action: string;
  entityType: string;
  entityId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  createdAt: Date;
};

export type AdminDashboard = {
  records: {
    total: number;
    issued: number;
    /** ISSUED rows carrying at least one genuine gap — the real workload. */
    withGap: number;
    /** How many reps that workload spans. 100 of 158 in the June file. */
    repsWithGap: number;
    /** ISSUED with no policy number. Three in the June file, and the sharpest signal in it. */
    anomalies: number;
    byGap: Record<GapType, number>;
  };
  batches: {
    total: number;
    committed: number;
    lastCommittedAt: Date | null;
    byStatus: { status: string; count: number }[];
  };
  corrections: {
    total: number;
    /** With a verifier. NOT the whole in-flight count — see `verified`. */
    pending: number;
    /** Verified and waiting on an approver. */
    verified: number;
    returned: number;
    approved: number;
    rejected: number;
    withdrawn: number;
  };
  /**
   * Duplicate `Apps_No` rows sitting in staging.
   *
   * The master table cannot hold one — `sales_record.apps_no` is UNIQUE — so a
   * duplicate only ever exists in `upload_batch_row`, flagged during validation
   * and excluded from commit (section 6.6). Counting master rows for duplicates
   * would therefore always return zero and tell the admin nothing.
   */
  duplicateRows: number;
  activity: ActivityEntry[];
};

export async function getAdminDashboard(): Promise<AdminDashboard> {
  const [records, batchTotals, batchesByStatus, corrections, duplicates, activity] =
    await Promise.all([
      db
        .select({
          total: countAll,
          issued: countFiltered(ISSUED_CONDITION),
          withGap: countFiltered(ANY_GAP_CONDITION),
          repsWithGap: countDistinctFiltered(salesRecord.smId, REP_GAP_CONDITION),
          anomalies: countFiltered(ANOMALY_CONDITION),
          missingIssuedDate: countFiltered(gapCondition('MISSING_ISSUED_DATE')),
          missingPolicyNo: countFiltered(gapCondition('MISSING_POLICY_NO')),
          missingAutopay: countFiltered(gapCondition('MISSING_AUTOPAY')),
        })
        .from(salesRecord),

      db
        .select({
          total: countAll,
          committed: countFiltered(eq(uploadBatch.status, 'COMMITTED')),
          // mapWith, because drizzle's node-postgres driver deliberately leaves
          // timestamps as raw strings and lets the column codec parse them. A
          // bare sql`max(...)` therefore yields "2026-07-27 09:15:30.897+00"
          // rather than a Date, and every downstream formatter would be handed
          // a string it has to re-parse.
          lastCommittedAt: sql<Date | null>`max(${uploadBatch.committedAt})`.mapWith(
            uploadBatch.committedAt,
          ),
        })
        .from(uploadBatch),

      db
        .select({ status: uploadBatch.status, count: countAll })
        .from(uploadBatch)
        .groupBy(uploadBatch.status)
        .orderBy(desc(countAll)),

      db
        .select({
          total: countAll,
          // Split across the two review stages — 2026-07-28 spec section 3.
          // Counting only PENDING would make every verified request invisible
          // here, and the parts would stop summing to the total.
          pending: countFiltered(eq(correctionRequest.status, 'PENDING')),
          verified: countFiltered(eq(correctionRequest.status, 'VERIFIED')),
          returned: countFiltered(eq(correctionRequest.status, 'RETURNED')),
          approved: countFiltered(eq(correctionRequest.status, 'APPROVED')),
          rejected: countFiltered(eq(correctionRequest.status, 'REJECTED')),
          withdrawn: countFiltered(eq(correctionRequest.status, 'WITHDRAWN')),
        })
        .from(correctionRequest),

      db
        .select({ count: countFiltered(eq(uploadBatchRow.isDuplicate, true)) })
        .from(uploadBatchRow),

      db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          entityType: auditLog.entityType,
          entityId: auditLog.entityId,
          actorEmail: auditLog.actorEmail,
          actorRole: auditLog.actorRole,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        // id breaks the tie: several rows of one transaction share a timestamp,
        // and an unstable order makes the panel flicker between refreshes.
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(ACTIVITY_LIMIT),
    ]);

  const r = records[0];
  const b = batchTotals[0];
  const c = corrections[0];

  return {
    records: {
      total: r.total,
      issued: r.issued,
      withGap: r.withGap,
      repsWithGap: r.repsWithGap,
      anomalies: r.anomalies,
      byGap: {
        MISSING_ISSUED_DATE: r.missingIssuedDate,
        MISSING_POLICY_NO: r.missingPolicyNo,
        MISSING_AUTOPAY: r.missingAutopay,
      },
    },
    batches: {
      total: b.total,
      committed: b.committed,
      lastCommittedAt: b.lastCommittedAt,
      byStatus: batchesByStatus,
    },
    corrections: {
      total: c.total,
      // All six, so the parts sum to `total`. The query already computed
      // `verified` and `withdrawn` and this object then dropped them on the
      // floor, which is why the admin's "Corrections pending" card read 0 while
      // a request sat with an approver: `pending` is PENDING alone, and nothing
      // on that dashboard counted the stage after it.
      pending: c.pending,
      verified: c.verified,
      returned: c.returned,
      approved: c.approved,
      rejected: c.rejected,
      withdrawn: c.withdrawn,
    },
    duplicateRows: duplicates[0].count,
    activity,
  };
}
