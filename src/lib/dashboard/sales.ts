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
import type { GapType } from '@/lib/records/gaps';
import { ANY_GAP_CONDITION, ISSUED_CONDITION, countAll, countFiltered, gapCondition } from './sql';

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
    pending: number;
    approved: number;
    rejected: number;
    /** Waiting on the rep, not on the approver — section 7. */
    returned: number;
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
        issued: countFiltered(ISSUED_CONDITION),
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
        pending: countFiltered(eq(correctionRequest.status, 'PENDING')),
        approved: countFiltered(eq(correctionRequest.status, 'APPROVED')),
        rejected: countFiltered(eq(correctionRequest.status, 'REJECTED')),
        returned: countFiltered(eq(correctionRequest.status, 'RETURNED')),
      })
      .from(correctionRequest)
      .where(eq(correctionRequest.submittedBy, user.id)),
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
      pending: q.pending,
      approved: q.approved,
      rejected: q.rejected,
      returned: q.returned,
    },
  };
}
