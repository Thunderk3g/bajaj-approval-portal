/**
 * Exporting one reconciliation month — spec section 8.
 *
 * `ExportFilters` could scope by batch, by rep and by issuance date, but not by
 * PERIOD, so "give me the business dashboard for July" had no answer: a month is
 * not a batch (July can be several uploads) and it is not an issuance-date range
 * (a June-issued policy first seen in July belongs to July's cycle, and a PENDING
 * application has no issuance date at all).
 *
 * That last point is the trap this suite exists to pin down. The issued-date
 * bounds drop rows whose `issued_date` is NULL, and those rows are precisely the
 * monthly worklist. A period filter that behaved the same way would hand an admin
 * a file that looks like a complete month with its whole open queue missing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { period, salesRecord } from '@/db/schema';
import { exportFiltersSchema, describeFilters, NO_FILTERS } from '@/lib/export/schemas';
import { fetchExportRecords } from '@/lib/export/queries';
import { truncateAll } from '../helpers/db';

const JUNE = '2026-06';
const JULY = '2026-07';

let juneId: string;
let julyId: string;

beforeEach(async () => {
  await truncateAll();

  const rows = await db
    .insert(period)
    .values([
      { code: JUNE, label: 'Jun 2026', startsOn: '2026-06-01', endsOn: '2026-06-30', status: 'CLOSED' },
      { code: JULY, label: 'Jul 2026', startsOn: '2026-07-01', endsOn: '2026-07-31' },
    ])
    .returning({ id: period.id, code: period.code });

  juneId = rows.find((r) => r.code === JUNE)!.id;
  julyId = rows.find((r) => r.code === JULY)!.id;

  await db.insert(salesRecord).values([
    {
      appsNo: '5920000001',
      smId: 'C2CM21350',
      status: 'ISSUED',
      issuedDate: '2026-06-10',
      periodId: juneId,
      extra: {},
    },
    {
      appsNo: '5920000002',
      smId: 'C2CM21350',
      status: 'ISSUED',
      issuedDate: '2026-07-05',
      periodId: julyId,
      extra: {},
    },
    // Issued in June, first reconciled in July: it is July's row, and no June
    // date range would ever find it.
    {
      appsNo: '5920000003',
      smId: 'C2CM21351',
      status: 'ISSUED',
      issuedDate: '2026-06-28',
      periodId: julyId,
      extra: {},
    },
    // PENDING, so no issuance date at all. Still July's workload.
    {
      appsNo: '5920000004',
      smId: 'C2CM21351',
      status: 'PENDING',
      issuedDate: null,
      periodId: julyId,
      extra: {},
    },
    // Never stamped — an import that predates periods. Belongs to no month.
    { appsNo: '5920000005', smId: 'C2CM21351', status: 'ISSUED', issuedDate: '2026-07-09', extra: {} },
  ]);
});

const appsNosOf = async (filters: Parameters<typeof fetchExportRecords>[0]) =>
  (await fetchExportRecords(filters)).map((r) => r.appsNo).sort();

describe('the period filter selects the month, not a date range', () => {
  it('returns every row the month carried, PENDING ones included', async () => {
    expect(await appsNosOf({ ...NO_FILTERS, periodCode: JULY })).toEqual([
      '5920000002',
      '5920000003',
      '5920000004',
    ]);
  });

  it('returns the other month without them', async () => {
    expect(await appsNosOf({ ...NO_FILTERS, periodCode: JUNE })).toEqual(['5920000001']);
  });

  it('leaves an unstamped record out of every month', async () => {
    const all = await appsNosOf(NO_FILTERS);
    expect(all).toContain('5920000005');
    expect(await appsNosOf({ ...NO_FILTERS, periodCode: JULY })).not.toContain('5920000005');
    expect(await appsNosOf({ ...NO_FILTERS, periodCode: JUNE })).not.toContain('5920000005');
  });

  it('exports nothing rather than everything for a month that does not exist', async () => {
    // The failure mode worth naming: a subquery that matched no period must
    // narrow to nothing, not fall through to an unfiltered export.
    expect(await appsNosOf({ ...NO_FILTERS, periodCode: '1999-01' })).toEqual([]);
  });

  it('combines with the other filters rather than replacing them', async () => {
    expect(await appsNosOf({ ...NO_FILTERS, periodCode: JULY, smId: 'C2CM21351' })).toEqual([
      '5920000003',
      '5920000004',
    ]);
  });

  it('loses the PENDING rows the moment a date range is added — which is why it is offered alone', async () => {
    // Documented, not endorsed. `issued_date` bounds compare against a NULL and
    // drop the row, so pairing the two filters silently removes the worklist.
    expect(
      await appsNosOf({ ...NO_FILTERS, periodCode: JULY, issuedFrom: '2026-07-01' }),
    ).toEqual(['5920000002']);
  });
});

describe('the filter set records the month it was scoped to', () => {
  it('parses a YYYY-MM code and rejects anything else', () => {
    const ok = exportFiltersSchema.safeParse({ periodCode: JULY });
    expect(ok.success && ok.data.periodCode).toBe(JULY);

    // An untouched select posts '', which must mean "no filter" rather than
    // reaching the query as a real value that matches nothing.
    const blank = exportFiltersSchema.safeParse({ periodCode: '' });
    expect(blank.success && blank.data.periodCode).toBeNull();

    expect(exportFiltersSchema.safeParse({ periodCode: 'July' }).success).toBe(false);
  });

  it('says which month, in words a reader still understands a year later', () => {
    expect(describeFilters({ ...NO_FILTERS, periodCode: JULY })).toContain(`Period ${JULY}`);
  });
});
