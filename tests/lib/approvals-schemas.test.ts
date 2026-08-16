import { describe, expect, it } from 'vitest';
import {
  BULK_MAX,
  bulkDecisionSchema,
  CATEGORY_LABELS,
  CORRECTION_CATEGORIES,
  decisionSchema,
  parseHistoryFilters,
  parseQueueFilters,
} from '@/lib/approvals/schemas';
import { bulkVerifierDecisionSchema } from '@/lib/verification/schemas';
import { zodFieldErrors } from '@/lib/result';

describe('decision validation (spec 7)', () => {
  const requestId = '4f1a3d7c-2a0c-4a7e-9f2b-2f7a9c1e5b30';

  it('accepts an approval with no remarks', () => {
    const parsed = decisionSchema.safeParse({ requestId, decision: 'APPROVE', remarks: '' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.remarks).toBeNull();
  });

  it('refuses a rejection with no reason', () => {
    // A rejection with no reason leaves the submitter nothing to act on, so the
    // request comes straight back with the same defect.
    const parsed = decisionSchema.safeParse({ requestId, decision: 'REJECT', remarks: '   ' });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && zodFieldErrors(parsed.error).remarks).toBeDefined();
  });

  it('refuses a return with no reason', () => {
    const parsed = decisionSchema.safeParse({ requestId, decision: 'RETURN', remarks: '' });
    expect(parsed.success).toBe(false);
  });

  it('trims remarks before storing them', () => {
    const parsed = decisionSchema.safeParse({
      requestId,
      decision: 'REJECT',
      remarks: '  no proof  ',
    });
    expect(parsed.success && parsed.data.remarks).toBe('no proof');
  });

  it('rejects an identifier that is not a uuid', () => {
    expect(
      decisionSchema.safeParse({ requestId: '1 OR 1=1', decision: 'APPROVE' }).success,
    ).toBe(false);
  });
});

describe('filter parsing (spec 9.1)', () => {
  it('defaults the queue to what the approver can actually act on', () => {
    // MINE, which is a STAGE question, not a status one.
    //
    // It was PENDING, then VERIFIED after the 2026-07-28 verifier gate. Both
    // were the same mistake at different times: they name a status and hope it
    // still means "at the approver's rung". Since the N-stage engine, VERIFIED
    // is set after ANY non-final rung passes, so on a five-rung mapping chain it
    // also covers requests parked with two managers and a second verifier — a
    // queue that lies about its own depth in the other direction, offering rows
    // the engine then refuses.
    expect(parseQueueFilters({}).scope).toBe('MINE');
  });

  it('ignores an unrecognised filter rather than erroring the page', () => {
    // These arrive from a hand-editable query string on a read-only screen; a
    // bad bookmark should render the default view, not a stack trace.
    const filters = parseQueueFilters({ scope: 'ANYTHING', category: 'DROP TABLE' });
    expect(filters.scope).toBe('MINE');
    expect(filters.category).toBeUndefined();
  });

  it('reads the scopes and categories it does know', () => {
    const filters = parseQueueFilters({ scope: 'open', category: 'mapping', q: ' 616 ' });
    expect(filters).toEqual({ scope: 'OPEN', category: 'MAPPING', q: '616' });
  });

  it('keeps only well-formed dates on the history filter', () => {
    expect(parseHistoryFilters({ from: '2026-06-01', to: 'last tuesday' })).toMatchObject({
      from: '2026-06-01',
      to: undefined,
    });
  });

  it('reads the "my decisions only" toggle', () => {
    expect(parseHistoryFilters({ mine: '1' }).mine).toBe(true);
    expect(parseHistoryFilters({}).mine).toBe(false);
  });
});

describe('batch decision validation', () => {
  const ids = [
    '4f1a3d7c-2a0c-4a7e-9f2b-2f7a9c1e5b30',
    '8c2b4e9d-1f3a-4b6c-8d7e-3a5b7c9d1e2f',
  ];

  it('carries the same remarks rules as a single decision', () => {
    expect(
      bulkDecisionSchema.safeParse({ requestIds: ids, decision: 'APPROVE', remarks: '' }).success,
    ).toBe(true);
    expect(
      bulkDecisionSchema.safeParse({ requestIds: ids, decision: 'REJECT', remarks: '  ' }).success,
    ).toBe(false);
    expect(
      bulkDecisionSchema.safeParse({ requestIds: ids, decision: 'RETURN', remarks: '' }).success,
    ).toBe(false);
  });

  it('collapses a repeated id, because the same id twice is not two decisions', () => {
    // Left in, the second copy reaches the approval path, finds the request no
    // longer VERIFIED — it just approved it — and is reported as a failure. The
    // approver would see their own success counted against them.
    const parsed = bulkDecisionSchema.safeParse({
      requestIds: [ids[0], ids[1], ids[0]],
      decision: 'APPROVE',
    });
    expect(parsed.success && parsed.data.requestIds).toEqual(ids);
  });

  it('refuses an empty selection', () => {
    const parsed = bulkDecisionSchema.safeParse({ requestIds: [], decision: 'APPROVE' });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && zodFieldErrors(parsed.error).requestIds).toBeDefined();
  });

  it('caps how many requests one batch may carry', () => {
    // The endpoint is reachable without the queue page, and an unbounded array
    // is an unbounded sequence of transactions held open by one request.
    const many = Array.from(
      { length: BULK_MAX + 1 },
      (_, i) => `4f1a3d7c-2a0c-4a7e-9f2b-${String(i).padStart(12, '0')}`,
    );
    expect(bulkDecisionSchema.safeParse({ requestIds: many, decision: 'APPROVE' }).success).toBe(
      false,
    );
  });

  it('refuses an identifier that is not a uuid', () => {
    expect(
      bulkDecisionSchema.safeParse({ requestIds: ['1 OR 1=1'], decision: 'APPROVE' }).success,
    ).toBe(false);
  });

  it('gives the verifier only the two decisions that stage has', () => {
    // A verifier has no terminal reject — their "no" returns the request to the
    // rep. If this ever parsed, the refusal would rest entirely on the action
    // remembering to check, which is where such rules get dropped silently.
    expect(
      bulkVerifierDecisionSchema.safeParse({ requestIds: ids, decision: 'VERIFY' }).success,
    ).toBe(true);
    expect(
      bulkVerifierDecisionSchema.safeParse({
        requestIds: ids,
        decision: 'REJECT',
        remarks: 'no',
      }).success,
    ).toBe(false);
    expect(
      bulkVerifierDecisionSchema.safeParse({ requestIds: ids, decision: 'RETURN', remarks: '' })
        .success,
    ).toBe(false);
  });
});

describe('the correction categories a reviewer can filter by', () => {
  it('includes AGENT_ID and labels every value', () => {
    // The queue's category dropdown is built from this list. A category a rep
    // can raise but a reviewer cannot filter for is one that disappears into
    // "everything else" exactly when it starts generating volume.
    expect(CORRECTION_CATEGORIES).toContain('AGENT_ID');
    for (const category of CORRECTION_CATEGORIES) {
      expect(CATEGORY_LABELS[category]).toBeTruthy();
    }
  });
});
