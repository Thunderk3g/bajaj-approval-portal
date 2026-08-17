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
 *
 * Deliberately still the RAW `status` column, and deliberately NOT
 * `OUTCOME_CONDITION.issued` below: this is the JS twin of `detectGaps`, which
 * reads `status` and is also mirrored a third time in `src/lib/records/query.ts`
 * for the record grid. Repointing one of the three at the effective status and
 * not the other two would make the grid and the dashboard report different
 * workloads — the exact failure the parity test exists to catch. See the report
 * note: 8 APPROVED rows with no policy number are counted as anomalies here and
 * are pending business under the taxonomy below.
 */
const GAP_SCOPE_CONDITION: SQL = sql`upper(btrim(coalesce(${salesRecord.status}, ''))) = ${ISSUED_STATUS}`;

const MISSING: Record<GapType, SQL> = {
  MISSING_ISSUED_DATE: sql`${salesRecord.issuedDate} is null`,
  MISSING_POLICY_NO: sql`coalesce(btrim(${salesRecord.policyNo}), '') = ''`,
  MISSING_AUTOPAY: sql`coalesce(btrim(${salesRecord.autopay}), '') = ''`,
};

export function gapCondition(type: GapType): SQL {
  return sql`(${GAP_SCOPE_CONDITION} and ${MISSING[type]})`;
}

/** An ISSUED row carrying at least one genuine gap — the actual worklist. */
export const ANY_GAP_CONDITION: SQL = sql`(${GAP_SCOPE_CONDITION} and (${sql.join(
  GAP_TYPES.map((type) => MISSING[type]),
  sql` or `,
)}))`;

/**
 * ISSUED with no policy number. Only three exist in the June file, which is
 * exactly why section 6.4 wants them at the top of the admin dashboard rather
 * than averaged into a gap total dominated by 249 missing AutoPay flags.
 */
export const ANOMALY_CONDITION: SQL = gapCondition('MISSING_POLICY_NO');

/* --------------------------------------------------- the outcome of a policy */

/**
 * What actually happened to an application — the one definition, and the one
 * every screen that reports an outcome reads.
 *
 * `sales_record` carries two status columns and the portal reported on `status`
 * alone. `status` IS the final status, with two exceptions the business named,
 * both of which the sheet leaves standing at ISSUED when it should not:
 *
 *   Status = ISSUED, Status 2 = FREELOOK CANCEL → the customer cancelled inside
 *     the free-look window. The policy was issued and then was not: REJECTED.
 *   Status = ISSUED, Status 2 = APPROVED        → approved, not yet issued.
 *     Still in flight: PENDING.
 *
 * Everything else keeps the status the sheet wrote — `PRE-UNITIZE` stays ISSUED
 * and `PSTPNE%` stays REJECTED, because no rule moves them. Fourteen of the
 * June file's 1,400 rows change bucket: ISSUED 865 → 851, PENDING 364 → 375,
 * REJECTED 171 → 174. A correction, not a re-model.
 *
 * Derived on READ and never written back. `manpower_override` leaves `manpower`
 * alone for the same reason: next month's workbook has to be reconcilable
 * against exactly what was imported, and the uploads to come are mostly status
 * changes to policies already here. Nothing caches this — a re-import is picked
 * up by the next query with no migration and nothing to invalidate.
 *
 * The nuance the three buckets fold away — a postponement is not a decline, a
 * free-look cancellation is neither, a PRE-UNITIZE is issued but not yet
 * unitized — survives as the REASON (`OUTCOME_REASON`), shown beside the outcome
 * rather than turned into buckets nobody asked for.
 */
const STATUS = sql`upper(btrim(coalesce(${salesRecord.status}, '')))`;
const STATUS_2 = sql`upper(btrim(coalesce(${salesRecord.status2}, '')))`;

export const OUTCOMES = ['issued', 'pending', 'rejected'] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * `status`, overridden in exactly the two cases above.
 *
 * The last two branches are not decoration: `status` is free text with no CHECK
 * behind it, so the case has to answer with one of three values whatever the
 * import wrote. An unrecognised status lands in PENDING — the reading that
 * cannot overstate production — and `UNCLASSIFIED_CONDITION` is what stops that
 * being silent.
 */
export const EFFECTIVE_STATUS: SQL<string> = sql<string>`case
  when ${STATUS} = 'ISSUED' and ${STATUS_2} = 'FREELOOK CANCEL' then 'REJECTED'
  when ${STATUS} = 'ISSUED' and ${STATUS_2} = 'APPROVED' then 'PENDING'
  when ${STATUS} in ('ISSUED', 'REJECTED') then ${STATUS}
  else 'PENDING'
end`;

/** The three buckets. Mutually exclusive and exhaustive, so they sum to logins. */
export const OUTCOME_CONDITION: Record<Outcome, SQL> = {
  issued: sql`(${EFFECTIVE_STATUS}) = 'ISSUED'`,
  pending: sql`(${EFFECTIVE_STATUS}) = 'PENDING'`,
  rejected: sql`(${EFFECTIVE_STATUS}) = 'REJECTED'`,
};

/**
 * The reason behind the outcome — `PSTPNE6`, `C_OFFER`, `PRE-UNITIZE`.
 *
 * Null, not `''`, when the sheet left it blank: 297 pending rows carry no reason
 * at all and the screens render that as an em dash. A blank rendered as a reason
 * would be inventing one.
 */
export const OUTCOME_REASON: SQL<string | null> = sql<string | null>`nullif(${STATUS_2}, '')`;

/**
 * A `status` this portal has no name for — the tripwire, expected to be zero.
 *
 * The workbook carries exactly three, but the column is free text, so a fourth
 * arriving in a future import is a thing that can happen. Such a row is counted
 * as PENDING by the `else` above and counted here as well, so a screen can say
 * out loud that it is guessing rather than quietly reporting it as business in
 * flight.
 */
export const UNCLASSIFIED_CONDITION: SQL = sql`${STATUS} not in ('ISSUED', 'PENDING', 'REJECTED')`;
