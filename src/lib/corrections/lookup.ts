import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { salesRecord } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import type { SessionUser } from '@/lib/auth/rbac';
import { normalizeIdentifier } from '@/lib/import/normalize';
import { checkLookupRateLimit } from '@/lib/rate-limit';
import { type ActionResult, fail, ok } from '@/lib/result';
import { lookupSchema } from './schemas';

/**
 * The scoping exception — spec section 7.2.
 *
 * Everywhere else, a sales user reads through `scopedRecordCondition`, which
 * pins the query to their own SM_ID. This file is the one deliberate hole in
 * that, and it exists because the security model and the business requirement
 * genuinely conflict: a rep whose sale was credited to somebody else cannot see
 * that record, so under strict scoping they could never raise the very mapping
 * claim the category exists for.
 *
 * The exception is safe only because of what it is NOT. Enumeration is the
 * threat — a sales user walking this endpoint to reconstruct the whole book —
 * and three properties together are what stop it:
 *
 *   1. Exact match on one application number. No wildcard, no prefix, no
 *      listing, no filtering by somebody else's SM_ID. One question, one answer.
 *   2. A restricted projection of six fields. No premium figures, no policy
 *      number, no contact details, no attachments. Even a successful walk would
 *      not yield anything worth having.
 *   3. Twenty per user per hour, counted from the audit log so it survives a
 *      restart, plus an audit row for every attempt — so intent is visible even
 *      when the limit is not reached.
 *
 * Widening any one of the three re-opens the hole. This is the only place in
 * the codebase that may read a record outside the caller's scope, and it must
 * stay the only one.
 */

/**
 * The six permitted fields — nothing else may ever be added to this type.
 *
 * `smName`, not `smId`: the claimant needs to know who currently holds the sale
 * so they can say whether the attribution is wrong. The identifier itself buys
 * them nothing the name does not, and leaking a scoping key is worse than
 * leaking a display name.
 */
export type RecordLookupResult = {
  appsNo: string;
  clientName: string | null;
  productName: string | null;
  status: string | null;
  issuedDate: string | null;
  smName: string | null;
};

export type LookupOutcome = {
  /** null means "no such application", which is a legitimate answer here. */
  record: RecordLookupResult | null;
  remaining: number;
};

/**
 * A full application number, after identifier normalization.
 *
 * The predicate is `eq`, so a `%` could never act as a wildcard anyway — but
 * refusing the shape outright is what makes "exact match only" a property of the
 * code rather than an accident of which operator happens to be in use today.
 */
const EXACT_APPS_NO = /^[A-Za-z0-9-]{4,32}$/;

export async function lookupRecordByAppsNo(
  actor: SessionUser,
  input: unknown,
): Promise<ActionResult<LookupOutcome>> {
  const parsed = lookupSchema.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'Enter the full application number.');
  }

  const { value: appsNo } = normalizeIdentifier(parsed.data.appsNo, 'appsNo');
  if (!appsNo || !EXACT_APPS_NO.test(appsNo)) {
    return fail('Enter a complete application number — partial numbers are not searched.');
  }

  const verdict = await checkLookupRateLimit(actor.id);
  if (!verdict.allowed) {
    // Deliberately NOT audited as a RECORD_LOOKUP. The limiter counts those
    // rows, so auditing a blocked attempt under the same action would let every
    // rejection extend the window that caused it — a user who hit the wall once
    // could never get back under it. The attempt is not lost: it is reported to
    // the caller, and the twenty rows that closed the window are already in the
    // log.
    return fail(
      `You have used all ${verdict.limit} record lookups for this hour. Try again after ${verdict.retryAt.toLocaleTimeString('en-IN')}.`,
    );
  }

  // The projection is written out column by column rather than selecting the row
  // and deleting keys. A `select()` that later gains a column would silently
  // start leaking it; this cannot.
  const [row] = await db
    .select({
      appsNo: salesRecord.appsNo,
      clientName: salesRecord.clientName,
      productName: salesRecord.productName,
      status: salesRecord.status,
      issuedDate: salesRecord.issuedDate,
      smName: salesRecord.smName,
    })
    .from(salesRecord)
    .where(eq(salesRecord.appsNo, appsNo))
    .limit(1);

  // Written whether or not it matched — section 7.2. A miss is the more
  // interesting row of the two: a run of them is what enumeration looks like.
  await writeAudit({
    actor,
    action: 'RECORD_LOOKUP',
    entityType: 'sales_record',
    entityId: appsNo,
    metadata: { appsNo, matched: Boolean(row), reason: 'MAPPING_CLAIM_LOOKUP' },
  });

  return ok({
    record: row
      ? {
          appsNo: row.appsNo,
          clientName: row.clientName,
          productName: row.productName,
          status: row.status,
          issuedDate: row.issuedDate,
          smName: row.smName,
        }
      : null,
    remaining: Math.max(0, verdict.limit - verdict.used - 1),
  });
}
