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
  peerStanding,
  ratio,
  rejectionRate,
  sortPerformanceRows,
  sumMetrics,
  type PerformanceMetrics,
  type PerformanceRow,
} from '@/lib/dashboard/performance';

/** A row with the counts stated, and pending derived the way the loader derives it. */
function row(
  code: string,
  counts: { logins: number; issued: number; rejected: number; anp?: string; fp?: string },
): PerformanceRow {
  return {
    code,
    name: code,
    placeholder: false,
    logins: counts.logins,
    issued: counts.issued,
    rejected: counts.rejected,
    pending: counts.logins - counts.issued - counts.rejected,
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

    const idle = row('ICCSP9', { logins: 0, issued: 0, rejected: 0 });
    expect(issuanceRate(idle)).toBeNull();
    expect(rejectionRate(idle)).toBeNull();
    expect(formatPercent(issuanceRate(idle))).toBe('—');

    const busy = row('ICCSP8', { logins: 40, issued: 0, rejected: 0 });
    expect(formatPercent(issuanceRate(busy))).toBe('0.0%');
  });

  it('reads a negative denominator as no denominator, not as a negative bar', () => {
    expect(ratio(1, -4)).toBeNull();
    expect(ratio(Number.NaN, 4)).toBeNull();
  });

  it('computes issuance, rejection and login share off a known fixture', () => {
    const rows = [
      row('ICCSP1', { logins: 100, issued: 70, rejected: 20 }),
      row('ICCSP2', { logins: 50, issued: 20, rejected: 5 }),
      row('ICCSP3', { logins: 0, issued: 0, rejected: 0 }),
    ];
    const totals = sumMetrics(rows);

    expect(totals.logins).toBe(150);
    expect(formatPercent(issuanceRate(rows[0]))).toBe('70.0%');
    expect(formatPercent(rejectionRate(rows[0]))).toBe('20.0%');
    expect(formatPercent(issuanceRate(rows[1]))).toBe('40.0%');
    expect(formatPercent(rejectionRate(rows[1]))).toBe('10.0%');

    // Login share is against the SCOPED total, so the column adds to 100%.
    expect(formatPercent(loginShare(rows[0], totals))).toBe('66.7%');
    expect(formatPercent(loginShare(rows[1], totals))).toBe('33.3%');
    expect(formatPercent(loginShare(rows[2], totals))).toBe('0.0%');

    // And against an empty scope there is no share at all, rather than 0%.
    expect(loginShare(rows[0], ZERO_METRICS)).toBeNull();
  });
});

describe('the accounting invariant', () => {
  it('always sums issued + rejected + pending back to logins', () => {
    // Including the case the invariant exists for: a fourth status value. It
    // lands in pending — it does not vanish — and `unclassified` is what says so.
    const withStrayStatus: PerformanceMetrics = {
      logins: 30,
      issued: 12,
      rejected: 3,
      pending: 30 - 12 - 3,
      unclassified: 4,
      anp: '0',
      fp: '0',
    };

    expect(withStrayStatus.issued + withStrayStatus.rejected + withStrayStatus.pending).toBe(
      withStrayStatus.logins,
    );
    expect(withStrayStatus.unclassified).toBeGreaterThan(0);
  });

  it('survives being added up', () => {
    const rows = [
      row('A', { logins: 13, issued: 7, rejected: 2 }),
      row('B', { logins: 41, issued: 40, rejected: 1 }),
      row('C', { logins: 0, issued: 0, rejected: 0 }),
    ];
    const totals = sumMetrics(rows);

    expect(totals.logins).toBe(54);
    expect(totals.issued + totals.rejected + totals.pending).toBe(totals.logins);
  });

  it('adds money as paise, so a column of rupees does not drift', () => {
    const rows = [
      row('A', { logins: 1, issued: 1, rejected: 0, anp: '0.10', fp: '1234567890.99' }),
      row('B', { logins: 1, issued: 1, rejected: 0, anp: '0.10', fp: '0.01' }),
      row('C', { logins: 1, issued: 1, rejected: 0, anp: '0.10', fp: '0.00' }),
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
    row('A', { logins: 100, issued: 90, rejected: 5, anp: '900.00' }),
    row('B', { logins: 10, issued: 1, rejected: 9, anp: '1200.00' }),
    row('C', { logins: 0, issued: 0, rejected: 0, anp: '0' }),
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
    sortPerformanceRows(rows, totals, 'rejection', 'asc');
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

describe('standing among peers', () => {
  // Four teams, one of which logged nothing at all this month.
  const teams = [
    { code: 'TL1', logins: 100, issued: 70 },
    { code: 'TL2', logins: 50, issued: 30 },
    { code: 'TL3', logins: 20, issued: 4 },
    { code: 'TL4', logins: 0, issued: 0 },
    // The unplaced bucket: policies the roster attaches to nobody. Not a team,
    // so not a competitor — ranking against it would invent a rival.
    { code: null, logins: 30, issued: 29 },
  ];

  it('places a team against the others and says what the middle is', () => {
    const standing = peerStanding('tl', teams, 'TL2');

    expect(standing.rank).toBe(2);
    expect(standing.peers).toBe(3);
    expect(standing.rate).toBeCloseTo(0.6);
    // 20%, 60%, 70% — the middle team, not the middle of the range.
    expect(standing.median).toBeCloseTo(0.6);
    // Pooled, so a big team weighs more than a small one: 104 of 170.
    expect(standing.average).toBeCloseTo(104 / 170);
  });

  it('gives a team with no logins no position rather than last place', () => {
    const standing = peerStanding('tl', teams, 'TL4');

    expect(standing.rate).toBeNull();
    expect(standing.rank).toBeNull();
    // The field is still described — it is the subject that has no place in it.
    expect(standing.peers).toBe(3);
    expect(standing.median).toBeCloseTo(0.6);
  });

  it('shares a place between ties instead of breaking them arbitrarily', () => {
    const tied = [
      { code: 'A', logins: 10, issued: 9 },
      { code: 'B', logins: 4, issued: 2 },
      { code: 'C', logins: 100, issued: 50 },
      { code: 'D', logins: 8, issued: 1 },
    ];

    expect(peerStanding('sm', tied, 'B').rank).toBe(2);
    expect(peerStanding('sm', tied, 'C').rank).toBe(2);
    expect(peerStanding('sm', tied, 'D').rank).toBe(4);
    // Even count: the median is the average of the two middle rates.
    expect(peerStanding('sm', tied, 'A').median).toBeCloseTo(0.5);
  });

  it('answers with an empty field rather than a division by zero', () => {
    const empty = peerStanding('acm', [], 'CCM1');

    expect(empty).toMatchObject({ rank: null, rate: null, peers: 0, median: null, average: null });
    // A caller who is not in the list is not silently ranked into it either.
    expect(peerStanding('tl', teams, 'TL999').rank).toBeNull();
  });
});
