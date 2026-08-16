import { z } from 'zod';
import { BULK_MAX, CORRECTION_CATEGORIES, type SearchParams } from '@/lib/approvals/schemas';

/**
 * Verifier decision input — 2026-07-28 spec section 3.
 *
 * Two decisions, not three. There is no terminal reject at this stage: a
 * verifier's "no" returns the request to the salesperson with remarks, which is
 * the answer they can act on. Only an approver can kill a request outright.
 *
 * A terminal verifier reject would create a second way for a request to die
 * without an approver ever seeing it — invisible in approver history and in the
 * export's decision column, with no appeal short of raising a brand-new request
 * that has lost its evidence and its conversation.
 */

export const VERIFIER_DECISIONS = ['VERIFY', 'RETURN'] as const;
export type VerifierDecision = (typeof VERIFIER_DECISIONS)[number];

const MAX_REMARKS = 2000;

/**
 * Remarks are optional on verify and required on return, so this is a
 * discriminated union rather than one object with a conditional check — the same
 * shape, and the same reasoning, as the approver's `decisionSchema`. A return
 * with no reason is a request for "something" the rep cannot supply.
 */
export const verifierDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    requestId: z.uuid('That request identifier is not valid.'),
    decision: z.literal('VERIFY'),
    remarks: z
      .string()
      .trim()
      .max(MAX_REMARKS, `Remarks are limited to ${MAX_REMARKS} characters.`)
      .optional()
      .transform((v) => (v ? v : null)),
  }),
  z.object({
    requestId: z.uuid('That request identifier is not valid.'),
    decision: z.literal('RETURN'),
    remarks: z
      .string()
      .trim()
      .min(1, 'Remarks are required so the submitter knows what to change.')
      .max(MAX_REMARKS, `Remarks are limited to ${MAX_REMARKS} characters.`),
  }),
]);

export type VerifierDecisionPayload = z.infer<typeof verifierDecisionSchema>;

/* --------------------------------------------------------------------- bulk */

/**
 * The batch form of the two decisions above.
 *
 * Restated rather than shared with the approver's `bulkDecisionSchema`, for the
 * reason the single-request schemas are not shared either: the two stages offer
 * DIFFERENT decisions. A union that accepted 'APPROVE' here would validate a
 * payload no verifier is allowed to send, and leave the refusal to the action —
 * where a future edit can drop it silently.
 *
 * The id array's rules are shared, because those are about the transport rather
 * than the stage: same cap, same deduplication, same reasons.
 */
const bulkRequestIds = z
  .array(z.uuid('That request identifier is not valid.'))
  .min(1, 'Select at least one request.')
  .max(BULK_MAX, `Decide at most ${BULK_MAX} requests at a time.`)
  .transform((ids) => [...new Set(ids)]);

export const bulkVerifierDecisionSchema = z.discriminatedUnion('decision', [
  z.object({
    requestIds: bulkRequestIds,
    decision: z.literal('VERIFY'),
    remarks: z
      .string()
      .trim()
      .max(MAX_REMARKS, `Remarks are limited to ${MAX_REMARKS} characters.`)
      .optional()
      .transform((v) => (v ? v : null)),
  }),
  z.object({
    requestIds: bulkRequestIds,
    decision: z.literal('RETURN'),
    remarks: z
      .string()
      .trim()
      .min(1, 'Remarks are required so the submitter knows what to change.')
      .max(MAX_REMARKS, `Remarks are limited to ${MAX_REMARKS} characters.`),
  }),
]);

/* ------------------------------------------------------------------ filters */

/**
 * PENDING is the verifier's own queue; VERIFIED is what they have passed on and
 * is shown so a verifier can see whether the approver stage is draining.
 * RETURNED is waiting on the rep.
 */
/**
 * `MINE` is not a status, and that is the point of it.
 *
 * The other four ask `correction_request.status`, which describes a two-rung
 * world: `PENDING` meant "with the verifier" only while the verifier was rung
 * zero and the approver was rung one. The shipped chains are longer —
 * `ISSUANCE_DATE` is V1 → V2 → APPROVER — and a request the first verifier
 * cleared is `VERIFIED` with a SECOND verifier rung open, which the status
 * scopes describe as somebody else's work. `MINE` asks the stage table instead
 * and is therefore the only scope that answers "what can I actually decide".
 */
export const VERIFIER_QUEUE_SCOPES = ['MINE', 'PENDING', 'VERIFIED', 'RETURNED', 'OPEN'] as const;
export type VerifierQueueScope = (typeof VERIFIER_QUEUE_SCOPES)[number];

export const VERIFIER_SCOPE_LABELS: Record<VerifierQueueScope, string> = {
  MINE: 'At my step',
  PENDING: 'At the first check',
  VERIFIED: 'Past the first check',
  RETURNED: 'Returned — awaiting the submitter',
  OPEN: 'Everything open',
};

/** The statuses that make up "open" for the verifier's queue. */
export const VERIFIER_OPEN_STATUSES = ['PENDING', 'VERIFIED', 'RETURNED'] as const;

export const VERIFIER_HISTORY_ACTIONS = ['VERIFIED', 'RETURNED'] as const;
export type VerifierHistoryAction = (typeof VERIFIER_HISTORY_ACTIONS)[number];

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

export function parseVerifierQueueFilters(params: SearchParams) {
  return {
    // Defaults to the work they can do, not to a status that used to mean that.
    scope: pick(params.scope, VERIFIER_QUEUE_SCOPES) ?? ('MINE' as VerifierQueueScope),
    category: pick(params.category, CORRECTION_CATEGORIES),
    q: one(params.q),
  };
}

export type VerifierQueueFilters = ReturnType<typeof parseVerifierQueueFilters>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseVerifierHistoryFilters(params: SearchParams) {
  const from = one(params.from);
  const to = one(params.to);
  return {
    action: pick(params.action, VERIFIER_HISTORY_ACTIONS),
    category: pick(params.category, CORRECTION_CATEGORIES),
    mine: one(params.mine) === '1',
    q: one(params.q),
    from: from && ISO_DATE.test(from) ? from : undefined,
    to: to && ISO_DATE.test(to) ? to : undefined,
  };
}

export type VerifierHistoryFilters = ReturnType<typeof parseVerifierHistoryFilters>;
