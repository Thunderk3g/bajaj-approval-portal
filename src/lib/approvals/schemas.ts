import { z } from 'zod';

/**
 * Decision input validation — spec section 7.
 *
 * Remarks are required on reject and return and optional on approve, so this is
 * a discriminated union rather than one object with a conditional check: a
 * rejection with no reason gives the submitter nothing to act on, and a return
 * with no reason is a request for "something" the submitter cannot supply.
 * Approval needs no justification — the applied value speaks for itself.
 *
 * The requiredness lives here, on the server, for the same reason spec 7.1 gives
 * for the `Others` description: client-side requiredness is a convenience, never
 * the control.
 */

export const DECISIONS = ['APPROVE', 'REJECT', 'RETURN'] as const;
export type Decision = (typeof DECISIONS)[number];

const MAX_REMARKS = 2000;

const optionalRemarks = z
  .string()
  .trim()
  .max(MAX_REMARKS, `Remarks are limited to ${MAX_REMARKS} characters.`)
  .optional()
  .transform((v) => (v ? v : null));

const requiredRemarks = z
  .string()
  .trim()
  .min(1, 'Remarks are required so the submitter knows what to change.')
  .max(MAX_REMARKS, `Remarks are limited to ${MAX_REMARKS} characters.`);

export const decisionSchema = z.discriminatedUnion('decision', [
  z.object({
    requestId: z.uuid('That request identifier is not valid.'),
    decision: z.literal('APPROVE'),
    remarks: optionalRemarks,
  }),
  z.object({
    requestId: z.uuid('That request identifier is not valid.'),
    decision: z.literal('REJECT'),
    remarks: requiredRemarks,
  }),
  z.object({
    requestId: z.uuid('That request identifier is not valid.'),
    decision: z.literal('RETURN'),
    remarks: requiredRemarks,
  }),
]);

export type DecisionPayload = z.infer<typeof decisionSchema>;

/* --------------------------------------------------------------------- bulk */

/**
 * The most requests one batch may carry.
 *
 * A ceiling rather than a page size: the queue pages at 100, so this covers a
 * full page with room for a wider one later. It exists because `requestIds`
 * arrives as a repeated form field on a POST endpoint reachable without the
 * page, and an unbounded array is an unbounded sequence of transactions held
 * open by one request.
 *
 * Defined here rather than beside `runBulk` on purpose — `bulk.ts` reaches
 * `apply.ts` and through it the database client, and this module is imported by
 * the queue pages. Keeping the constant on the pure side is what lets the limit
 * be stated in UI copy without dragging a connection pool into the bundle.
 */
export const BULK_MAX = 200;

/**
 * Deduplicated, because the same id twice is not two decisions.
 *
 * Without this the second copy reaches `applyApproval`, finds the request no
 * longer VERIFIED — it just approved it — and reports "already approved" as a
 * failure. The approver would see a batch of 40 come back as "39 applied, 1
 * failed" with no way to tell that the failure was their own success.
 */
const bulkRequestIds = z
  .array(z.uuid('That request identifier is not valid.'))
  .min(1, 'Select at least one request.')
  .max(BULK_MAX, `Decide at most ${BULK_MAX} requests at a time.`)
  .transform((ids) => [...new Set(ids)]);

export const bulkDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    requestIds: bulkRequestIds,
    decision: z.literal('APPROVE'),
    remarks: optionalRemarks,
  }),
  z.object({
    requestIds: bulkRequestIds,
    decision: z.literal('REJECT'),
    // One remark, applied to every request in the batch — so it has to be true
    // of all of them. That is a real constraint on the approver, not a gap: a
    // reason that only fits some of the selection is a sign the selection was
    // wrong, and they still have the per-request screen for the rest.
    remarks: requiredRemarks,
  }),
  z.object({
    requestIds: bulkRequestIds,
    decision: z.literal('RETURN'),
    remarks: requiredRemarks,
  }),
]);

export type BulkDecisionPayload = z.infer<typeof bulkDecisionSchema>;

/** Shared by both stages' bulk actions so one client component can render either. */
export type BulkOutcome = {
  decision: string;
  applied: number;
  failed: Array<{ requestId: string; message: string }>;
  warnings: string[];
};

/* ------------------------------------------------------------------ filters */

/**
 * The approver's scopes — 2026-07-28 spec section 3.
 *
 * VERIFIED replaced PENDING as the default and as "awaiting my decision".
 * PENDING remains selectable but now means "awaiting a VERIFIER", i.e. work that
 * is not the approver's yet. It is kept visible rather than hidden because a
 * PENDING pile that never shrinks is how an approver notices the verification
 * stage has stalled upstream of them — but it is deliberately not the default,
 * since an approver landing on a list they cannot act on would be a queue that
 * lies about its own depth.
 */
/**
 * `MINE` supersedes `VERIFIED` as the approver's working scope.
 *
 * `VERIFIED` was "awaiting my decision" while every chain was verifier →
 * approver. It is now set after ANY non-final rung passes, so on the shipped
 * `MAPPING_BETWEEN_TEAMS` chain (TL → ACM → V2 → ACM → APPROVER) it also covers
 * requests sitting with two managers and a second verifier — none of which the
 * approver may decide. The queue counted them, offered the button, and the
 * engine refused the click. `MINE` asks the stage table, so the list and the
 * gate agree by construction. `VERIFIED` is kept, relabelled honestly, because
 * a pile that never shrinks is still how an approver spots a stalled rung above
 * them.
 */
export const QUEUE_SCOPES = ['MINE', 'VERIFIED', 'PENDING', 'RETURNED', 'OPEN'] as const;
export type QueueScope = (typeof QUEUE_SCOPES)[number];

export const QUEUE_SCOPE_LABELS: Record<QueueScope, string> = {
  MINE: 'Awaiting my decision',
  VERIFIED: 'Past the first check — not necessarily yours',
  PENDING: 'Awaiting verification — not yours yet',
  RETURNED: 'Returned — awaiting the submitter',
  OPEN: 'Everything open',
};

/** Everything still in flight, for the OPEN scope. */
export const OPEN_QUEUE_STATUSES = ['PENDING', 'VERIFIED', 'RETURNED'] as const;

export const CORRECTION_CATEGORIES = [
  'AUTOPAY',
  'MAPPING',
  'ISSUANCE_DATE',
  'AGENT_ID',
  'OTHERS',
] as const;
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];

/**
 * The reviewer's shorter labels. Kept separate from the submitter's in
 * `corrections/schemas.ts` on purpose — a rep needs "Mapping (SM attribution)"
 * to pick the right category from a list they see once a month, a reviewer
 * reading forty badges in a column does not.
 */
export const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  AUTOPAY: 'AutoPay',
  MAPPING: 'Mapping',
  ISSUANCE_DATE: 'Issuance date',
  AGENT_ID: 'Agent ID',
  OTHERS: 'Others',
};

export const HISTORY_ACTIONS = ['APPROVED', 'REJECTED', 'RETURNED'] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/**
 * Filter parsing drops anything it does not recognise instead of rejecting it.
 *
 * These values arrive from a hand-editable query string on a read-only screen;
 * an unknown `category=DROP TABLE` is not a user error worth a message, and
 * silently ignoring it keeps the page rendering rather than erroring on a
 * malformed bookmark.
 */
function one(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() !== '' ? v.trim() : undefined;
}

function pick<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T | undefined {
  const v = one(value)?.toUpperCase();
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

export type SearchParams = Record<string, string | string[] | undefined>;

export function parseQueueFilters(params: SearchParams) {
  return {
    scope: pick(params.scope, QUEUE_SCOPES) ?? ('MINE' as QueueScope),
    category: pick(params.category, CORRECTION_CATEGORIES),
    q: one(params.q),
  };
}

export type QueueFilters = ReturnType<typeof parseQueueFilters>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseHistoryFilters(params: SearchParams) {
  const from = one(params.from);
  const to = one(params.to);
  return {
    action: pick(params.action, HISTORY_ACTIONS),
    category: pick(params.category, CORRECTION_CATEGORIES),
    mine: one(params.mine) === '1',
    q: one(params.q),
    from: from && ISO_DATE.test(from) ? from : undefined,
    to: to && ISO_DATE.test(to) ? to : undefined,
  };
}

export type HistoryFilters = ReturnType<typeof parseHistoryFilters>;
