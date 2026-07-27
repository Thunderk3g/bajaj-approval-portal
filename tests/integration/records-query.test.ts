/**
 * Search, sort, pagination and version reads against the real database.
 *
 * These exercise the parts that a unit test cannot: whether the predicates the
 * trigram indexes are meant to serve actually match, whether offset pages
 * partition the result rather than overlapping it, and whether money survives
 * the round trip as a string.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { salesRecord, salesRecordVersion } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import type { PageParams } from '@/lib/pagination';
import { EMPTY_FILTERS, type RecordFilters } from '@/lib/records/filters';
import { listRecords } from '@/lib/records/query';
import { listRecordVersions, versionChain } from '@/lib/records/versions';
import { makeUser, truncateAll } from '../helpers/db';

const SM = 'ICCSP90766';

function page(n: number, size = 25): PageParams {
  return { page: n, pageSize: size, offset: (n - 1) * size };
}

function filters(over: Partial<RecordFilters> = {}): RecordFilters {
  return { ...EMPTY_FILTERS, ...over };
}

let admin: SessionUser;
let adminId: string;

beforeEach(async () => {
  await truncateAll();
  const row = await makeUser({ role: 'admin', smId: null });
  adminId = row.id;
  admin = { id: row.id, email: row.email, name: row.name, role: 'admin', smId: null, isActive: true };
});

async function seed(rows: Array<Record<string, unknown>>) {
  await db.insert(salesRecord).values(
    rows.map((r) => ({ smId: SM, extra: {}, ...r })) as never,
  );
}

describe('free-text search (spec 9.1)', () => {
  beforeEach(async () => {
    await seed([
      { appsNo: '6167509571', policyNo: '0399120001', clientName: 'Anand Sharma', smName: 'Aarti Rep' },
      { appsNo: '6167509572', policyNo: '0399120002', clientName: 'Bhavna Rao', smName: 'Bharat Rep' },
      {
        appsNo: '6167509573',
        clientName: 'Chetan Iyer',
        smName: 'Aarti Rep',
        extra: { RECEIPT_NO: 'RCP-778812', Source: 'DIGITAL', LA_Occupation: 'Engineer' },
      },
      { appsNo: '5920000001', clientName: '100% Cover Trust', smName: 'Aarti Rep' },
    ]);
  });

  async function search(q: string) {
    const { rows } = await listRecords(admin, filters({ q }), page(1));
    return rows.map((r) => r.appsNo).sort();
  }

  it('matches a substring of the application number', async () => {
    expect(await search('6750957')).toEqual(['6167509571', '6167509572', '6167509573']);
  });

  it('matches a substring of the policy number', async () => {
    expect(await search('120002')).toEqual(['6167509572']);
  });

  it('matches the client name case-insensitively', async () => {
    expect(await search('sharma')).toEqual(['6167509571']);
  });

  it('matches the SM name', async () => {
    expect(await search('Bharat')).toEqual(['6167509572']);
  });

  it('matches inside the preserved extra columns', async () => {
    // Section 9.1 requires `extra` to be searchable so a receipt number that
    // never got a first-class column is still findable.
    expect(await search('RCP-778812')).toEqual(['6167509573']);
    expect(await search('Engineer')).toEqual(['6167509573']);
  });

  it('reads % as text rather than as a wildcard', async () => {
    // Unescaped this would return every row in the table.
    expect(await search('%')).toEqual(['5920000001']);
  });

  it('reads _ as text rather than as any-single-character', async () => {
    expect(await search('a_b')).toEqual([]);
  });

  it('returns nothing for a term that matches no column', async () => {
    expect(await search('zzzznotfound')).toEqual([]);
  });
});

describe('sorting and offset pagination', () => {
  beforeEach(async () => {
    await seed([
      { appsNo: 'A1', issuedDate: '2026-06-01', anp: '1000.00', fp: '250.50', status: 'ISSUED' },
      { appsNo: 'A2', issuedDate: '2026-06-05', anp: '20000.00', fp: '4195.42', status: 'ISSUED' },
      { appsNo: 'A3', issuedDate: null, anp: null, fp: null, status: 'PENDING' },
      { appsNo: 'A4', issuedDate: '2026-06-03', anp: '300.00', fp: '75.00', status: 'ISSUED' },
      { appsNo: 'A5', issuedDate: '2026-06-03', anp: '300.00', fp: '75.00', status: 'ISSUED' },
    ]);
  });

  it('sorts descending with nulls last by default', async () => {
    const { rows, total } = await listRecords(admin, filters(), page(1));
    expect(total).toBe(5);
    expect(rows.map((r) => r.appsNo)).toEqual(['A2', 'A4', 'A5', 'A1', 'A3']);
  });

  it('keeps nulls last when the direction flips', async () => {
    // A null issued date means "not issued yet", not "issued at the beginning of
    // time" — it belongs at the end whichever way the column is sorted.
    const { rows } = await listRecords(admin, filters({ dir: 'asc' }), page(1));
    expect(rows[rows.length - 1].appsNo).toBe('A3');
  });

  it('breaks ties on apps_no so pages cannot overlap', async () => {
    // A4 and A5 share an issued date. Without the unique tiebreaker Postgres is
    // free to order them differently per query, which duplicates one row across
    // two pages and hides another entirely.
    const first = await listRecords(admin, filters(), page(1, 3));
    const second = await listRecords(admin, filters(), page(2, 3));
    const seen = [...first.rows, ...second.rows].map((r) => r.appsNo);
    expect(new Set(seen).size).toBe(5);
    expect(first.rows.map((r) => r.appsNo)).toEqual(['A2', 'A4', 'A5']);
    expect(second.rows.map((r) => r.appsNo)).toEqual(['A1', 'A3']);
  });

  it('reports the unpaginated total alongside a partial page', async () => {
    const { rows, total } = await listRecords(admin, filters(), page(1, 2));
    expect(rows).toHaveLength(2);
    expect(total).toBe(5);
  });

  it('returns an empty page past the end without failing', async () => {
    const { rows, total } = await listRecords(admin, filters(), page(9, 25));
    expect(rows).toEqual([]);
    expect(total).toBe(5);
  });

  it('sorts money by value, not by text', async () => {
    const { rows } = await listRecords(admin, filters({ sort: 'anp', dir: 'desc' }), page(1));
    expect(rows.map((r) => r.appsNo).slice(0, 3)).toEqual(['A2', 'A1', 'A4']);
  });

  it('returns money as a string, never a number', async () => {
    const { rows } = await listRecords(admin, filters({ sort: 'appsNo', dir: 'asc' }), page(1));
    expect(rows[1].fp).toBe('4195.42');
    expect(typeof rows[1].fp).toBe('string');
    expect(typeof rows[1].anp).toBe('string');
  });
});

describe('date-range and correction filters', () => {
  beforeEach(async () => {
    await seed([
      { appsNo: 'D1', issuedDate: '2026-06-01', status: 'ISSUED', hasCorrections: true },
      { appsNo: 'D2', issuedDate: '2026-06-15', status: 'ISSUED', hasCorrections: false },
      { appsNo: 'D3', issuedDate: '2026-07-08', status: 'ISSUED', hasCorrections: false },
    ]);
  });

  it('bounds the issued date inclusively at both ends', async () => {
    const { rows } = await listRecords(
      admin,
      filters({ issuedFrom: '2026-06-01', issuedTo: '2026-06-15' }),
      page(1),
    );
    expect(rows.map((r) => r.appsNo).sort()).toEqual(['D1', 'D2']);
  });

  it('filters on the has-corrections flag in both directions', async () => {
    const yes = await listRecords(admin, filters({ hasCorrections: true }), page(1));
    const no = await listRecords(admin, filters({ hasCorrections: false }), page(1));
    expect(yes.rows.map((r) => r.appsNo)).toEqual(['D1']);
    expect(no.rows.map((r) => r.appsNo).sort()).toEqual(['D2', 'D3']);
  });
});

describe('version chain (spec 5.5)', () => {
  beforeEach(async () => {
    await seed([{ appsNo: 'V1', status: 'ISSUED', autopay: 'Yes', issuedDate: '2026-06-03' }]);
    const [record] = await db.select().from(salesRecord).where(eq(salesRecord.appsNo, 'V1'));

    await db.insert(salesRecordVersion).values([
      {
        recordId: record.id,
        version: 1,
        data: { appsNo: 'V1', autopay: null, smId: SM, extra: { Source: '-' } },
        changeType: 'IMPORT',
        changedBy: null,
      },
      {
        recordId: record.id,
        version: 2,
        data: { appsNo: 'V1', autopay: 'Yes', smId: SM, extra: { Source: '-' } },
        changeType: 'CORRECTION',
        changedFields: ['autopay'],
        changedBy: adminId,
        note: 'AutoPay confirmed from mandate',
      },
    ]);
  });

  it('returns the chain newest first', async () => {
    const versions = await listRecordVersions(admin, 'V1');
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('resolves the actor, and leaves it null for a system import', async () => {
    const [latest, first] = await listRecordVersions(admin, 'V1');
    expect(latest.actorEmail).toBeTruthy();
    expect(first.actorName).toBeNull();
  });

  it('diffs each version against the one before it', async () => {
    const chain = versionChain(await listRecordVersions(admin, 'V1'));
    expect(chain[0].diffs).toEqual([
      { field: 'autopay', label: 'AutoPay', from: null, to: 'Yes' },
    ]);
    expect(chain[1].isBaseline).toBe(true);
  });

  it('returns nothing for an Apps_No with no versions', async () => {
    expect(await listRecordVersions(admin, 'NOPE')).toEqual([]);
  });
});
