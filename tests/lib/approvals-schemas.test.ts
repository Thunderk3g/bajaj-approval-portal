import { describe, expect, it } from 'vitest';
import { decisionSchema, parseHistoryFilters, parseQueueFilters } from '@/lib/approvals/schemas';
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
    expect(parseQueueFilters({}).scope).toBe('PENDING');
  });

  it('ignores an unrecognised filter rather than erroring the page', () => {
    // These arrive from a hand-editable query string on a read-only screen; a
    // bad bookmark should render the default view, not a stack trace.
    const filters = parseQueueFilters({ scope: 'ANYTHING', category: 'DROP TABLE' });
    expect(filters.scope).toBe('PENDING');
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
