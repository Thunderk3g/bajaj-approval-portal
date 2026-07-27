/**
 * The SQL half of gap detection — the twin of `detectGaps` in
 * `@/lib/records/gaps`, and the reason the dashboards report the real workload.
 *
 * Dashboard counts are aggregates: fetching 1,171 rows to count them in
 * JavaScript would be both slower and a second, drifting implementation of the
 * section 6.4 rules. So the rules are expressed once more, here, in SQL — and
 * `tests/integration/dashboard-gaps.test.ts` asserts these predicates agree with
 * `detectGaps` row for row on the same seeded data. If the two ever diverge the
 * dashboard misreports the workload, which is the failure this whole file is
 * shaped to prevent.
 *
 * Two details carry that parity:
 *
 * - `detectGaps` treats whitespace-only text as blank, so the text predicates
 *   are `coalesce(btrim(col), '') = ''` and not `col IS NULL`. An import that
 *   ever wrote `''` rather than NULL would otherwise vanish from the counts
 *   while still showing as a gap on the record itself.
 * - `detectGaps` compares status case-insensitively after trimming, so the
 *   status predicate does the same. Status is normalized on import, but the
 *   dashboards must not depend on that having happened.
 */

import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { salesRecord } from '@/db/schema';
import { GAP_TYPES, ISSUED_STATUS, type GapType } from '@/lib/records/gaps';

/** `count(*)` as an int4 so node-postgres hands back a number, not a bigint string. */
export const countAll: SQL<number> = sql<number>`cast(count(*) as integer)`;

export function countFiltered(condition: SQL): SQL<number> {
  return sql<number>`cast(count(*) filter (where ${condition}) as integer)`;
}

export function countDistinctFiltered(column: AnyColumn, condition: SQL): SQL<number> {
  return sql<number>`cast(count(distinct ${column}) filter (where ${condition}) as integer)`;
}

/**
 * The one status under which a blank is actionable — spec section 6.4.
 *
 * 105 blank issuance dates and 105 blank policy numbers in the June file belong
 * to PENDING applications and are entirely correct. Without this predicate the
 * dashboards would raise 210 false tasks and bury the 250 genuine ones.
 */
export const ISSUED_CONDITION: SQL = sql`upper(btrim(coalesce(${salesRecord.status}, ''))) = ${ISSUED_STATUS}`;

const MISSING: Record<GapType, SQL> = {
  MISSING_ISSUED_DATE: sql`${salesRecord.issuedDate} is null`,
  MISSING_POLICY_NO: sql`coalesce(btrim(${salesRecord.policyNo}), '') = ''`,
  MISSING_AUTOPAY: sql`coalesce(btrim(${salesRecord.autopay}), '') = ''`,
};

export function gapCondition(type: GapType): SQL {
  return sql`(${ISSUED_CONDITION} and ${MISSING[type]})`;
}

/** An ISSUED row carrying at least one genuine gap — the actual worklist. */
export const ANY_GAP_CONDITION: SQL = sql`(${ISSUED_CONDITION} and (${sql.join(
  GAP_TYPES.map((type) => MISSING[type]),
  sql` or `,
)}))`;

/**
 * ISSUED with no policy number. Only three exist in the June file, which is
 * exactly why section 6.4 wants them at the top of the admin dashboard rather
 * than averaged into a gap total dominated by 249 missing AutoPay flags.
 */
export const ANOMALY_CONDITION: SQL = gapCondition('MISSING_POLICY_NO');
