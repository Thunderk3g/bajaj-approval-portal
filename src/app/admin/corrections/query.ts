/**
 * The admin view of every correction request — spec section 9.
 *
 * Read-only by design. The approver owns the decision, and an admin screen with
 * approve/reject controls would hand the same authority to a second role
 * without the side-by-side comparison and proof preview that makes the decision
 * defensible. What the admin needs here is oversight: what has been raised,
 * by whom, against which application, and where it got to.
 *
 * Kept out of `src/lib/dashboard/**` because it is a list, not an aggregate —
 * and out of the page itself so the filters can be exercised directly by
 * `tests/integration/dashboard-corrections.test.ts`.
 */

import { and, count, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import {
  correctionCategoryEnum,
  correctionRequest,
  correctionStatusEnum,
  user,
} from '@/db/schema';

export const CORRECTION_STATUSES = correctionStatusEnum.enumValues;
export const CORRECTION_CATEGORIES = correctionCategoryEnum.enumValues;

export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];

export type CorrectionFilters = {
  status: CorrectionStatus | null;
  category: CorrectionCategory | null;
  smId: string | null;
  /** Inclusive `YYYY-MM-DD` bounds on `submitted_at`. */
  from: string | null;
  to: string | null;
  /** Substring match on `Apps_No`. */
  q: string | null;
};

export type CorrectionRow = {
  id: string;
  appsNo: string;
  category: CorrectionCategory;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string;
  status: CorrectionStatus;
  smId: string;
  submittedAt: Date;
  submitterName: string | null;
  submitterEmail: string | null;
  reviewedAt: Date | null;
  reviewerName: string | null;
  resubmissionCount: number;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * Reads filters out of the query string, dropping anything it does not
 * recognise.
 *
 * Enum filters are validated against the database's own vocabulary rather than
 * passed through: comparing `correction_status` to a hand-typed `?status=FOO`
 * makes Postgres raise "invalid input value for enum", so an unvalidated
 * parameter turns a curious URL edit into a 500.
 */
export function parseCorrectionFilters(
  params: Record<string, string | string[] | undefined>,
): CorrectionFilters {
  const from = first(params.from);
  const to = first(params.to);

  return {
    status: oneOf(first(params.status), CORRECTION_STATUSES),
    category: oneOf(first(params.category), CORRECTION_CATEGORIES),
    // SM_ID is stored uppercase everywhere (the six mixed-case reps of section
    // 6.3), so a lowercase filter must match rather than silently return none.
    smId: first(params.smId)?.toUpperCase() ?? null,
    from: from && DATE_ONLY.test(from) ? from : null,
    to: to && DATE_ONLY.test(to) ? to : null,
    q: first(params.q),
  };
}

/** `%` and `_` are wildcards in LIKE; a literal search term must not smuggle them in. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function whereFor(filters: CorrectionFilters): SQL | undefined {
  const parts: SQL[] = [];

  if (filters.status) parts.push(eq(correctionRequest.status, filters.status));
  if (filters.category) parts.push(eq(correctionRequest.category, filters.category));
  if (filters.smId) parts.push(eq(correctionRequest.smId, filters.smId));
  if (filters.from) parts.push(gte(correctionRequest.submittedAt, sql`${filters.from}::date`));
  // The upper bound is exclusive on the *next* day: submitted_at is a timestamp,
  // so `<= to::date` would compare against midnight and hide everything raised
  // during the last day of the range — including every request when from = to.
  if (filters.to) {
    parts.push(lt(correctionRequest.submittedAt, sql`(${filters.to}::date + interval '1 day')`));
  }
  if (filters.q) parts.push(ilike(correctionRequest.appsNo, `%${escapeLike(filters.q)}%`));

  return parts.length ? and(...parts) : undefined;
}

export async function countCorrections(filters: CorrectionFilters): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(correctionRequest)
    .where(whereFor(filters));
  return row?.value ?? 0;
}

export async function listCorrections(
  filters: CorrectionFilters,
  page: { limit: number; offset: number },
): Promise<CorrectionRow[]> {
  const reviewer = alias(user, 'reviewer');

  return db
    .select({
      id: correctionRequest.id,
      appsNo: correctionRequest.appsNo,
      category: correctionRequest.category,
      fieldLabel: correctionRequest.fieldLabel,
      originalValue: correctionRequest.originalValue,
      proposedValue: correctionRequest.proposedValue,
      status: correctionRequest.status,
      smId: correctionRequest.smId,
      submittedAt: correctionRequest.submittedAt,
      submitterName: user.name,
      submitterEmail: user.email,
      reviewedAt: correctionRequest.reviewedAt,
      reviewerName: reviewer.name,
      resubmissionCount: correctionRequest.resubmissionCount,
    })
    .from(correctionRequest)
    // Left, not inner: submitted_by is NOT NULL, but a request must never
    // disappear from an oversight screen because of a join that did not match.
    .leftJoin(user, eq(user.id, correctionRequest.submittedBy))
    .leftJoin(reviewer, eq(reviewer.id, correctionRequest.reviewedBy))
    .where(whereFor(filters))
    .orderBy(desc(correctionRequest.submittedAt), desc(correctionRequest.id))
    .limit(page.limit)
    .offset(page.offset);
}

/* ------------------------------------------------- steps waiting on an admin */

export type StuckStage = {
  requestId: string;
  appsNo: string;
  smId: string;
  stageKey: string;
  resolverKey: string;
  sequence: number;
  totalStages: number;
  submittedAt: Date;
};

/**
 * The rungs that resolved to nobody and are therefore the administrators' to clear.
 *
 * The engine's documented behaviour when a hierarchy rung cannot be resolved —
 * the roster places the rep under no team leader, or names a manager who has no
 * portal account — is to open the rung anyway, pin nobody to it, notify the
 * administrators and let only them decide it. Every part of that worked except
 * the last: there was no list, and the notification linked to a route that did
 * not exist, so "the step falls to the administrators" meant in practice that
 * the request stopped dead and nothing on any screen said so.
 *
 * `assigned_user_id is null and resolver_key <> 'ROLE'` is the whole definition,
 * and it is the same predicate `actorStageCondition` uses for its admin arm —
 * one fact, asked by the list and by the gate.
 *
 * Read-only oversight is this module's rule and this is the documented exception
 * to it: nobody else can clear these, so an admin screen that only reported them
 * would report a queue with no way out.
 */
export async function listStuckStages(limit = 50): Promise<StuckStage[]> {
  const rows = await db.execute<StuckStage>(sql`
    select s.request_id      as "requestId",
           r.apps_no         as "appsNo",
           r.sm_id           as "smId",
           s.stage_key       as "stageKey",
           s.resolver_key    as "resolverKey",
           s.sequence        as "sequence",
           r.total_stages    as "totalStages",
           r.submitted_at    as "submittedAt"
      from correction_request_stage s
      join correction_request r on r.id = s.request_id
     where s.status = 'ACTIVE'
       and s.assigned_user_id is null
       and s.resolver_key <> 'ROLE'
     order by r.submitted_at asc
     limit ${limit}
  `);

  return ((rows as unknown as { rows?: StuckStage[] }).rows ?? (rows as unknown as StuckStage[]));
}
