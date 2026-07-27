import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIR,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  filterFormValues,
  hasActiveFilters,
  parseRecordFilters,
  type SearchParams,
} from '@/lib/records/filters';
import type { Role } from '@/lib/auth/rbac';

const admin = { role: 'admin' as Role };
const sales = { role: 'sales' as Role };
const approver = { role: 'approver' as Role };

function parse(params: SearchParams, viewer = admin) {
  return parseRecordFilters(params, viewer);
}

describe('filter parsing (spec 9.1)', () => {
  it('reads the full filter set', () => {
    const filters = parse({
      q: 'Sharma',
      batchId: '11111111-2222-4333-8444-555555555555',
      smId: 'iccsp90766',
      status: 'issued',
      issuedFrom: '2026-06-01',
      issuedTo: '2026-06-30',
      gap: 'MISSING_AUTOPAY',
      hasCorrections: 'true',
      correctionStatus: 'PENDING',
      sort: 'anp',
      dir: 'asc',
    });

    expect(filters).toEqual({
      q: 'Sharma',
      batchId: '11111111-2222-4333-8444-555555555555',
      smId: 'ICCSP90766',
      status: 'ISSUED',
      issuedFrom: '2026-06-01',
      issuedTo: '2026-06-30',
      gap: 'MISSING_AUTOPAY',
      hasCorrections: true,
      correctionStatus: 'PENDING',
      sort: 'anp',
      dir: 'asc',
    });
  });

  it('uppercases SM_ID and status to match how they are stored', () => {
    // sales_record carries a CHECK that sm_id = upper(sm_id); a lowercase
    // filter value would match nothing and read as "this rep has no records".
    expect(parse({ smId: 'c2cm21350' }).smId).toBe('C2CM21350');
    expect(parse({ status: ' issued ' }).status).toBe('ISSUED');
  });
});

describe('a hand-edited URL degrades instead of throwing', () => {
  it('ignores a malformed batch id', () => {
    expect(parse({ batchId: 'not-a-uuid' }).batchId).toBeNull();
  });

  it.each(['yesterday', '2026-13-01', '01/06/2026', ''])('ignores the date %j', (value) => {
    expect(parse({ issuedFrom: value }).issuedFrom).toBeNull();
  });

  it('ignores an unknown gap type', () => {
    expect(parse({ gap: 'MISSING_EVERYTHING' }).gap).toBeNull();
  });

  it('ignores an unknown correction status', () => {
    expect(parse({ correctionStatus: 'MAYBE' }).correctionStatus).toBeNull();
  });

  it('falls back to the default sort rather than trusting the column name', () => {
    // ?sort= names a column that lands in an ORDER BY. Anything outside the
    // closed list has to be discarded here or it becomes an injection surface.
    expect(parse({ sort: 'sm_id; drop table sales_record' }).sort).toBe(DEFAULT_SORT);
    expect(parse({ dir: 'sideways' }).dir).toBe(DEFAULT_DIR);
  });

  it('ignores a non-boolean has-corrections value', () => {
    expect(parse({ hasCorrections: 'maybe' }).hasCorrections).toBeNull();
    expect(parse({ hasCorrections: 'false' }).hasCorrections).toBe(false);
  });

  it('drops a blank or whitespace-only search term', () => {
    expect(parse({ q: '   ' }).q).toBeNull();
    expect(parse({ q: '' }).q).toBeNull();
  });

  it('drops an oversized search term rather than turning it into an ILIKE pattern', () => {
    expect(parse({ q: 'x'.repeat(500) }).q).toBeNull();
  });

  it('collapses a repeated param to its first value', () => {
    expect(parse({ status: ['ISSUED', 'PENDING'] }).status).toBe('ISSUED');
  });

  it('returns the empty filter set for an empty URL', () => {
    expect(parse({})).toEqual(EMPTY_FILTERS);
  });
});

describe('the SM_ID filter is admin-only (spec 9.1)', () => {
  it('ignores ?smId= for a sales user', () => {
    // The load-bearing defence is scopedRecordCondition in query.ts; this is
    // the readable half. Both are asserted — see tests/integration/records-scope.
    expect(parse({ smId: 'SOMEONE_ELSE' }, sales).smId).toBeNull();
  });

  it('ignores ?smId= for an approver', () => {
    expect(parse({ smId: 'SOMEONE_ELSE' }, approver).smId).toBeNull();
  });

  it('keeps every other filter a sales user supplies', () => {
    const filters = parse({ smId: 'SOMEONE_ELSE', status: 'ISSUED', gap: 'ANY' }, sales);
    expect(filters.smId).toBeNull();
    expect(filters.status).toBe('ISSUED');
    expect(filters.gap).toBe('ANY');
  });

  it('honours ?smId= for an admin', () => {
    expect(parse({ smId: 'ICCSP90766' }, admin).smId).toBe('ICCSP90766');
  });
});

describe('filter form round-trip', () => {
  it('reports whether anything is narrowing the list', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters(parse({ sort: 'anp', dir: 'asc' }))).toBe(false);
    expect(hasActiveFilters(parse({ gap: 'ANY' }))).toBe(true);
  });

  it('renders unset filters as the empty string a <select> understands', () => {
    const values = filterFormValues(EMPTY_FILTERS);
    expect(values.status).toBe('');
    expect(values.hasCorrections).toBe('');
    expect(values.sort).toBe(DEFAULT_SORT);
  });

  it('renders a false has-corrections as "false", not as unset', () => {
    expect(filterFormValues(parse({ hasCorrections: 'false' })).hasCorrections).toBe('false');
  });
});
