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

/* ------------------------------------------------------------------ filters */

export const QUEUE_SCOPES = ['PENDING', 'RETURNED', 'OPEN'] as const;
export type QueueScope = (typeof QUEUE_SCOPES)[number];

export const QUEUE_SCOPE_LABELS: Record<QueueScope, string> = {
  PENDING: 'Awaiting my decision',
  RETURNED: 'Returned — awaiting the submitter',
  OPEN: 'Everything open',
};

export const CORRECTION_CATEGORIES = ['AUTOPAY', 'MAPPING', 'ISSUANCE_DATE', 'OTHERS'] as const;
export type CorrectionCategory = (typeof CORRECTION_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CorrectionCategory, string> = {
  AUTOPAY: 'AutoPay',
  MAPPING: 'Mapping',
  ISSUANCE_DATE: 'Issuance date',
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
    scope: pick(params.scope, QUEUE_SCOPES) ?? ('PENDING' as QueueScope),
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
