/**
 * Sales dashboard aggregates — spec section 9, scoped by spec section 4.1.
 *
 * Every record count composes `scopedRecordCondition(user)`. There is no
 * hand-written `sm_id = ...` anywhere in this file, deliberately: a scoping
 * predicate spelled out inline is a predicate that a later edit can drop, and
 * `tests/integration/dashboard-scoping.test.ts` exists precisely because the
 * failure mode — one rep seeing another rep's book — is silent.
 */

import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import { scopedRecordCondition, type SessionUser } from '@/lib/auth/rbac';
import { visibleRequestCondition } from '@/lib/corrections/queries';
import type { GapType } from '@/lib/records/gaps';
import { ANY_GAP_CONDITION, OUTCOME_CONDITION, countAll, countFiltered, gapCondition } from './sql';

export type SalesDashboard = {
  smId: string;
  records: {
    total: number;
    issued: number;
    /** The rep's actual worklist: median 6 rows, max 30 across the June file. */
    withGap: number;
    byGap: Record<GapType, number>;
  };
  requests: {
    total: number;
    /** With a verifier — the first gate (2026-07-28 spec section 3). */
    awaitingVerification: number;
    /** Verified and with an approver — the second gate. */
    awaitingApproval: number;
    /**
     * Both waiting states together. This is what the rep actually cares about
     * ("how many of my claims are still in flight"); the split above answers the
     * follow-up question of who is holding them.
     */
    open: number;
    approved: number;
    rejected: number;
    /** Waiting on the rep, not on a reviewer — section 7. */
    returned: number;
    /** Closed by the rep themselves, so it is neither open nor decided. */
    withdrawn: number;
  };
};

export async function getSalesDashboard(user: SessionUser): Promise<SalesDashboard> {
  // scopedRecordCondition returns undefined for an admin or approver, meaning
  // "no filter". Reading that as "nothing to add" here would turn a wrongly
  // routed caller into one that counts every record in the system, so the
  // absence of a scope is treated as a refusal rather than as a wildcard.
  const scope = scopedRecordCondition(user);
  if (!scope) {
    throw new AuthzError('FORBIDDEN', 'The sales dashboard is scoped to a sales account');
  }

  const [records, requests] = await Promise.all([
    db
      .select({
        total: countAll,
        issued: countFiltered(OUTCOME_CONDITION.issued),
        withGap: countFiltered(ANY_GAP_CONDITION),
        missingIssuedDate: countFiltered(gapCondition('MISSING_ISSUED_DATE')),
        missingPolicyNo: countFiltered(gapCondition('MISSING_POLICY_NO')),
        missingAutopay: countFiltered(gapCondition('MISSING_AUTOPAY')),
      })
      .from(salesRecord)
      .where(scope),

    // Requests are keyed on the submitter, not on sm_id. A mapping claim is
    // raised against a record the rep does not own yet (section 7.2), so
    // counting by sm_id would hide a rep's own claim from their own dashboard —
    // the one request they most need to track.
    db
      .select({
        total: countAll,
        /**
         * Split across the two review stages — 2026-07-28 spec section 3.
         *
         * Before the verifier gate there was one waiting state. Counting only
         * PENDING now would drop a request out of every bucket the moment it
         * cleared verification: the rep's status breakdown would stop summing to
         * `total`, and the "awaiting a decision" figure would go DOWN at exactly
         * the moment the request finally reached an approver. From the rep's
         * side that is indistinguishable from their claim being lost.
         */
        awaitingVerification: countFiltered(eq(correctionRequest.status, 'PENDING')),
        awaitingApproval: countFiltered(eq(correctionRequest.status, 'VERIFIED')),
        approved: countFiltered(eq(correctionRequest.status, 'APPROVED')),
        rejected: countFiltered(eq(correctionRequest.status, 'REJECTED')),
        returned: countFiltered(eq(correctionRequest.status, 'RETURNED')),
        withdrawn: countFiltered(eq(correctionRequest.status, 'WITHDRAWN')),
      })
      .from(correctionRequest)
      // Not `submitted_by = user.id`: a request their team leader raised for
      // their book is listed on /sales/requests, so counting only self-raised
      // ones here would make the tile disagree with the screen it links to.
      // `visibleRequestCondition` is the one predicate both sides share.
      .where(visibleRequestCondition(user)),
  ]);

  const r = records[0];
  const q = requests[0];

  return {
    smId: user.smId ?? '',
    records: {
      total: r.total,
      issued: r.issued,
      withGap: r.withGap,
      byGap: {
        MISSING_ISSUED_DATE: r.missingIssuedDate,
        MISSING_POLICY_NO: r.missingPolicyNo,
        MISSING_AUTOPAY: r.missingAutopay,
      },
    },
    requests: {
      total: q.total,
      awaitingVerification: q.awaitingVerification,
      awaitingApproval: q.awaitingApproval,
      open: q.awaitingVerification + q.awaitingApproval,
      approved: q.approved,
      rejected: q.rejected,
      returned: q.returned,
      withdrawn: q.withdrawn,
      // Every status the enum can hold is now counted, so the breakdown sums to
      // `total`. That is an invariant worth keeping: a rep who adds up the rows
      // and finds one missing has no way to tell which claim vanished.
    },
  };
}
