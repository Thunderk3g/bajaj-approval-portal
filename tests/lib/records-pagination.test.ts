import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import { likePattern } from '@/lib/records/query';
import { diffSnapshots, versionChain, type RecordVersion } from '@/lib/records/versions';

describe('pagination maths (spec 9.1)', () => {
  it('defaults to 25 rows, which is the whole worklist of the busiest rep', () => {
    // Section 6.4: max 30 gap rows per rep, median 6. The default page size is
    // chosen so a rep almost never has to paginate their own queue.
    expect(parsePageParams({}).pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(25);
  });

  it('computes the offset from page and size', () => {
    expect(parsePageParams({ page: '1' }).offset).toBe(0);
    expect(parsePageParams({ page: '2', pageSize: '25' }).offset).toBe(25);
    expect(parsePageParams({ page: '4', pageSize: '100' }).offset).toBe(300);
  });

  it('clamps a hand-edited page size to an offered one', () => {
    expect(parsePageParams({ pageSize: '9999' }).pageSize).toBe(25);
    expect(parsePageParams({ pageSize: '50' }).pageSize).toBe(50);
  });

  it('refuses a page below one', () => {
    expect(parsePageParams({ page: '0' }).page).toBe(1);
    expect(parsePageParams({ page: '-3' }).offset).toBe(0);
    expect(parsePageParams({ page: 'two' }).page).toBe(1);
  });

  it('always reports at least one page, even with no rows', () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(1, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(1171, 25)).toBe(47);
  });

  it('keeps every active filter when changing page', () => {
    const query = buildQuery({ gap: 'ANY', status: 'ISSUED', page: '2' }, { page: 3 });
    const params = new URLSearchParams(query);
    expect(params.get('gap')).toBe('ANY');
    expect(params.get('status')).toBe('ISSUED');
    expect(params.get('page')).toBe('3');
  });

  it('drops a param whose override is undefined', () => {
    expect(buildQuery({ sort: 'anp', page: '5' }, { page: undefined })).toBe('?sort=anp');
  });
});

describe('ILIKE pattern escaping', () => {
  it('treats % and _ as text, not as wildcards', () => {
    // Unescaped, a search for "%" matches every row on demand.
    expect(likePattern('100%')).toBe('%100\\%%');
    expect(likePattern('a_b')).toBe('%a\\_b%');
    expect(likePattern('back\\slash')).toBe('%back\\\\slash%');
  });

  it('leaves an ordinary term alone apart from the wrapping wildcards', () => {
    expect(likePattern('6167509575')).toBe('%6167509575%');
  });
});

describe('version diffs (spec 5.5)', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    appsNo: '6167509575',
    smId: 'ICCSP90766',
    autopay: null,
    issuedDate: '2026-06-03',
    extra: { Source: '-', RECEIPT_NO: '900001' },
    ...over,
  });

  it('reports only the field that changed', () => {
    const diffs = diffSnapshots(base(), base({ autopay: 'Yes' }));
    expect(diffs).toEqual([{ field: 'autopay', label: 'AutoPay', from: null, to: 'Yes' }]);
  });

  it('labels a field from the canonical registry', () => {
    const [diff] = diffSnapshots(base(), base({ smId: 'C2CM21350' }));
    expect(diff.label).toBe('SM ID');
  });

  it('ignores bookkeeping columns that change on every write', () => {
    const diffs = diffSnapshots(
      base({ updatedAt: '2026-07-01', currentVersion: 1, hasCorrections: false }),
      base({ updatedAt: '2026-07-02', currentVersion: 2, hasCorrections: true }),
    );
    expect(diffs).toEqual([]);
  });

  it('descends one level into extra so a preserved column reads as a real change', () => {
    const diffs = diffSnapshots(base(), base({ extra: { Source: 'DIGITAL', RECEIPT_NO: '900001' } }));
    expect(diffs).toEqual([
      { field: 'extra.Source', label: 'Extra · Source', from: '-', to: 'DIGITAL' },
    ]);
  });

  it('treats a blank string and a null as the same absence', () => {
    expect(diffSnapshots(base({ autopay: null }), base({ autopay: '  ' }))).toEqual([]);
  });

  it('pairs each version with its predecessor and marks version 1 as the baseline', () => {
    const versions = [
      { version: 3, data: base({ autopay: 'Yes', smId: 'C2CM21350' }) },
      { version: 2, data: base({ autopay: 'Yes' }) },
      { version: 1, data: base() },
    ] as unknown as RecordVersion[];

    const chain = versionChain(versions);
    expect(chain[0].diffs.map((d) => d.field)).toEqual(['smId']);
    expect(chain[1].diffs.map((d) => d.field)).toEqual(['autopay']);
    expect(chain[2].isBaseline).toBe(true);
    expect(chain[2].diffs).toEqual([]);
  });
});
