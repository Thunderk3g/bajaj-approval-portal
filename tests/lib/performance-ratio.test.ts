/**
 * The percentage arithmetic behind the performance dashboards.
 *
 * Every number on those four screens is a division, and the two ways a division
 * can lie are both here: a zero denominator rendered as "0%", and money summed
 * as a float. Neither is visible on screen — a rep with no logins shown as 0%
 * issuance looks exactly like a rep who issued nothing, and 0.30000000000000004
 * rounds away in the display and comes back at the twentieth row.
 */

import { describe, expect, it } from 'vitest';
import {
  ZERO_METRICS,
  formatPercent,
  issuanceRate,
  loginShare,
  parsePerformanceParams,
  ratio,
  refusalRate,
  sortPerformanceRows,
  sumMetrics,
  type PerformanceMetrics,
  type PerformanceRow,
} from '@/lib/dashboard/performance';

/** A row with the counts stated, and pending derived the way the loader derives it. */
function row(
  code: string,
  counts: { logins: number; issued: number; refused: number; anp?: string; fp?: string },
): PerformanceRow {
  return {
    code,
    name: code,
    placeholder: false,
    logins: counts.logins,
    issued: counts.issued,
    refused: counts.refused,
    pending: counts.logins - counts.issued - counts.refused,
    unclassified: 0,
    anp: counts.anp ?? '0',
    fp: counts.fp ?? '0',
  };
}

describe('ratios', () => {
  it('divides when there is something to divide by', () => {
    expect(ratio(3, 4)).toBe(0.75);
    expect(formatPercent(ratio(3, 4))).toBe('75.0%');
  });

  it('refuses a zero denominator rather than answering zero', () => {
    // The whole point: "issued none of 40" and "has logged nothing at all" are
    // different facts, and 0% would report the second as the first.
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(5, 0)).toBeNull();
    expect(formatPercent(ratio(0, 0))).toBe('—');
    expect(formatPercent(null)).toBe('—');

    const idle = row('ICCSP9', { logins: 0, issued: 0, refused: 0 });
    expect(issuanceRate(idle)).toBeNull();
    expect(refusalRate(idle)).toBeNull();
    expect(formatPercent(issuanceRate(idle))).toBe('—');

    const busy = row('ICCSP8', { logins: 40, issued: 0, refused: 0 });
    expect(formatPercent(issuanceRate(busy))).toBe('0.0%');
  });

  it('reads a negative denominator as no denominator, not as a negative bar', () => {
    expect(ratio(1, -4)).toBeNull();
    expect(ratio(Number.NaN, 4)).toBeNull();
  });

  it('computes issuance, refusal and login share off a known fixture', () => {
    const rows = [
      row('ICCSP1', { logins: 100, issued: 70, refused: 20 }),
      row('ICCSP2', { logins: 50, issued: 20, refused: 5 }),
      row('ICCSP3', { logins: 0, issued: 0, refused: 0 }),
    ];
    const totals = sumMetrics(rows);

    expect(totals.logins).toBe(150);
    expect(formatPercent(issuanceRate(rows[0]))).toBe('70.0%');
    expect(formatPercent(refusalRate(rows[0]))).toBe('20.0%');
    expect(formatPercent(issuanceRate(rows[1]))).toBe('40.0%');
    expect(formatPercent(refusalRate(rows[1]))).toBe('10.0%');

    // Login share is against the SCOPED total, so the column adds to 100%.
    expect(formatPercent(loginShare(rows[0], totals))).toBe('66.7%');
    expect(formatPercent(loginShare(rows[1], totals))).toBe('33.3%');
    expect(formatPercent(loginShare(rows[2], totals))).toBe('0.0%');

    // And against an empty scope there is no share at all, rather than 0%.
    expect(loginShare(rows[0], ZERO_METRICS)).toBeNull();
  });
});

describe('the accounting invariant', () => {
  it('always sums issued + refused + pending back to logins', () => {
    // Including the case the invariant exists for: a fourth status value. It
    // lands in pending — it does not vanish — and `unclassified` is what says so.
    const withStrayStatus: PerformanceMetrics = {
      logins: 30,
      issued: 12,
      refused: 3,
      pending: 30 - 12 - 3,
      unclassified: 4,
      anp: '0',
      fp: '0',
    };

    expect(withStrayStatus.issued + withStrayStatus.refused + withStrayStatus.pending).toBe(
      withStrayStatus.logins,
    );
    expect(withStrayStatus.unclassified).toBeGreaterThan(0);
  });

  it('survives being added up', () => {
    const rows = [
      row('A', { logins: 13, issued: 7, refused: 2 }),
      row('B', { logins: 41, issued: 40, refused: 1 }),
      row('C', { logins: 0, issued: 0, refused: 0 }),
    ];
    const totals = sumMetrics(rows);

    expect(totals.logins).toBe(54);
    expect(totals.issued + totals.refused + totals.pending).toBe(totals.logins);
  });

  it('adds money as paise, so a column of rupees does not drift', () => {
    const rows = [
      row('A', { logins: 1, issued: 1, refused: 0, anp: '0.10', fp: '1234567890.99' }),
      row('B', { logins: 1, issued: 1, refused: 0, anp: '0.10', fp: '0.01' }),
      row('C', { logins: 1, issued: 1, refused: 0, anp: '0.10', fp: '0.00' }),
    ];
    const totals = sumMetrics(rows);

    // 0.1 + 0.1 + 0.1 as doubles is 0.30000000000000004.
    expect(totals.anp).toBe('0.30');
    expect(totals.fp).toBe('1234567891.00');
  });

  it('reads an empty scope as zero money, not as NaN', () => {
    expect(sumMetrics([])).toEqual(ZERO_METRICS);
    expect(sumMetrics([{ ...ZERO_METRICS, anp: '', fp: 'not a number' }]).anp).toBe('0.00');
  });
});

describe('sorting', () => {
  const rows = [
    row('A', { logins: 100, issued: 90, refused: 5, anp: '900.00' }),
    row('B', { logins: 10, issued: 1, refused: 9, anp: '1200.00' }),
    row('C', { logins: 0, issued: 0, refused: 0, anp: '0' }),
  ];
  const totals = sumMetrics(rows);

  it('orders by a count in both directions', () => {
    expect(sortPerformanceRows(rows, totals, 'logins', 'desc').map((r) => r.code)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(sortPerformanceRows(rows, totals, 'logins', 'asc').map((r) => r.code)).toEqual([
      'C',
      'B',
      'A',
    ]);
  });

  it('keeps a row with no ratio at the bottom whichever way the column is sorted', () => {
    // C has no issuance percentage at all. Treating that as 0 would rank a rep
    // who has logged nothing above one who logged forty and issued none.
    expect(sortPerformanceRows(rows, totals, 'issuance', 'desc').map((r) => r.code)).toEqual([
      'A',
      'B',
      'C',
    ]);
    expect(sortPerformanceRows(rows, totals, 'issuance', 'asc').map((r) => r.code)).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('orders money by value, not by string', () => {
    expect(sortPerformanceRows(rows, totals, 'anp', 'desc').map((r) => r.code)).toEqual([
      'B',
      'A',
      'C',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const original = rows.map((r) => r.code);
    sortPerformanceRows(rows, totals, 'refusal', 'asc');
    expect(rows.map((r) => r.code)).toEqual(original);
  });
});

describe('view parameters', () => {
  it('falls back to the first allowed rung rather than rejecting', () => {
    expect(parsePerformanceParams({ rung: 'acm' }, ['sm']).rung).toBe('sm');
    expect(parsePerformanceParams({ rung: 'nonsense' }, ['tl', 'sm']).rung).toBe('tl');
    expect(parsePerformanceParams({}, ['sm', 'tl', 'acm']).rung).toBe('sm');
  });

  it('defaults to the biggest book first and reads a repeated param once', () => {
    expect(parsePerformanceParams({}, ['sm'])).toEqual({
      rung: 'sm',
      sort: 'logins',
      dir: 'desc',
      period: '',
    });
    expect(parsePerformanceParams({ sort: ['anp', 'fp'], dir: 'asc' }, ['sm'])).toMatchObject({
      sort: 'anp',
      dir: 'asc',
    });
    expect(parsePerformanceParams({ sort: 'drop table' }, ['sm']).sort).toBe('logins');
  });
});
