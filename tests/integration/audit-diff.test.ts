import { describe, expect, it } from 'vitest';
import { describePayload, diffEntries, formatValue } from '@/app/admin/audit/diff';

describe('audit payload rendering (spec 5.9)', () => {
  it('shows only the fields that moved', () => {
    const entries = diffEntries(
      { payMode: 'CHEQUE', autopay: null, premium: '12500.50' },
      { payMode: 'UPI', autopay: 'Yes', premium: '12500.50' },
    );

    expect(entries).toEqual([
      { key: 'autopay', before: 'null', after: 'Yes' },
      { key: 'payMode', before: 'CHEQUE', after: 'UPI' },
    ]);
  });

  it('treats a key gained or lost as a change, not as unchanged', () => {
    expect(diffEntries({ a: 1 }, { a: 1, b: 2 })).toEqual([{ key: 'b', before: null, after: '2' }]);
    expect(diffEntries({ a: 1, b: 2 }, { a: 1 })).toEqual([{ key: 'b', before: '2', after: null }]);
  });

  it('distinguishes null from absent — both are facts in a trail', () => {
    // A field set to null and a field that was never recorded are different
    // events. Collapsing them would make a cleared value look like a no-op.
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue('')).toBe('""');
    expect(formatValue(false)).toBe('false');
    expect(formatValue(0)).toBe('0');
  });

  it('compares a nested value whole rather than walking it', () => {
    expect(diffEntries({ issues: [{ code: 'A' }] }, { issues: [{ code: 'A' }] })).toEqual([]);
    expect(diffEntries({ issues: [{ code: 'A' }] }, { issues: [{ code: 'B' }] })).toEqual([
      { key: 'issues', before: '[{"code":"A"}]', after: '[{"code":"B"}]' },
    ]);
  });

  it('falls back to raw JSON when there is nothing to compare against', () => {
    // USER_CREATE has no `before`. Forcing it into a two-column diff would imply
    // a previous state that never existed.
    expect(describePayload(null, { role: 'sales' })).toEqual({
      kind: 'raw',
      before: null,
      after: '{\n  "role": "sales"\n}',
    });

    expect(describePayload(null, null)).toEqual({ kind: 'none' });
  });

  it('reports an identical pair explicitly instead of as an empty payload', () => {
    expect(describePayload({ a: 1 }, { a: 1 })).toEqual({ kind: 'diff', entries: [] });
  });
});
