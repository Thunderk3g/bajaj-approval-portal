/**
 * The tests that matter most (spec section 11).
 *
 * Every assertion here is the same question asked a different way: can a sales
 * user reach a row that is not theirs? Through the list, through the count,
 * through the detail lookup, through the version chain, through a search term,
 * through a filter parameter, through a dropdown. If a future refactor drops
 * `scopedRecordCondition` from any one path, exactly one of these fails — which
 * is the whole point of writing them one path at a time rather than as a single
 * happy-path check.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AuthzError } from '@/lib/auth/errors';
import type { Role, SessionUser } from '@/lib/auth/rbac';
import { db } from '@/db/client';
import { correctionRequest, salesRecord, salesRecordVersion, uploadBatch } from '@/db/schema';
import { DEFAULT_PAGE_SIZE, type PageParams } from '@/lib/pagination';
import { EMPTY_FILTERS, parseRecordFilters, type RecordFilters } from '@/lib/records/filters';
import {
  countRecords,
  getRecord,
  listBatchOptions,
  listRecords,
  listSmIdOptions,
  listStatusOptions,
} from '@/lib/records/query';
import { listRecordVersions } from '@/lib/records/versions';
import { makeUser, truncateAll } from '../helpers/db';

const PAGE: PageParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 };
const A = 'ICCSP90766';
const B = 'C2CM21350';

function session(row: {
  id: string;
  email: string;
  name: string;
  role: Role;
  smId: string | null;
  isActive: boolean;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    smId: row.smId,
    isActive: row.isActive,
  };
}

function filters(over: Partial<RecordFilters> = {}): RecordFilters {
  return { ...EMPTY_FILTERS, ...over };
}

let salesA: SessionUser;
let salesB: SessionUser;
let admin: SessionUser;
let approver: SessionUser;
let batchId: string;

beforeEach(async () => {
  await truncateAll();

  const adminRow = await makeUser({ role: 'admin', smId: null, email: 'admin@example.test' });
  admin = session(adminRow);
  approver = session(
    await makeUser({ role: 'approver', smId: null, email: 'approver@example.test' }),
  );
  salesA = session(await makeUser({ role: 'sales', smId: A, email: 'a@example.test' }));
  salesB = session(await makeUser({ role: 'sales', smId: B, email: 'b@example.test' }));

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: 'june.xlsb',
      storedPath: 'uploads/june.xlsb',
      fileHash: 'abc123',
      status: 'COMMITTED',
      uploadedBy: adminRow.id,
    })
    .returning();
  batchId = batch.id;

  await db.insert(salesRecord).values([
    {
      appsNo: '6167509571',
      smId: A,
      smName: 'Aarti Rep',
      clientName: 'Anand Sharma',
      policyNo: 'POL-A-1',
      status: 'ISSUED',
      issuedDate: '2026-06-03',
      autopay: 'Yes',
      sourceBatchId: batchId,
      extra: { Source: 'DIGITAL' },
    },
    {
      appsNo: '6167509572',
      smId: A,
      smName: 'Aarti Rep',
      clientName: 'Bhavna Rao',
      status: 'ISSUED',
      issuedDate: '2026-06-05',
      sourceBatchId: batchId,
      extra: {},
    },
    {
      appsNo: '6167509573',
      smId: A,
      smName: 'Aarti Rep',
      clientName: 'Chetan Iyer',
      status: 'PENDING',
      sourceBatchId: batchId,
      extra: {},
    },
    {
      appsNo: '6167509581',
      smId: B,
      smName: 'Bharat Rep',
      clientName: 'Zoya Khan',
      policyNo: 'POL-B-1',
      status: 'ISSUED',
      issuedDate: '2026-06-07',
      sourceBatchId: batchId,
      extra: { RECEIPT_NO: 'SECRET-RECEIPT-9', Source: 'BRANCH' },
    },
    {
      appsNo: '6167509582',
      smId: B,
      smName: 'Bharat Rep',
      clientName: 'Yash Gupta',
      status: 'REJECTED',
      sourceBatchId: batchId,
      extra: {},
    },
  ]);
});

async function appsNosFor(viewer: SessionUser, f: RecordFilters = filters()) {
  const { rows } = await listRecords(viewer, f, PAGE);
  return rows.map((r) => r.appsNo).sort();
}

describe('the list query is scoped to the session, not to a parameter', () => {
  it('gives a sales user only their own SM_ID', async () => {
    expect(await appsNosFor(salesA)).toEqual(['6167509571', '6167509572', '6167509573']);
    expect(await appsNosFor(salesB)).toEqual(['6167509581', '6167509582']);
  });

  it('scopes the total count as well as the page', async () => {
    // A count built from a different predicate than the rows is how a UI ends
    // up announcing "5 records" over a list of 3.
    expect(await countRecords(salesA, filters())).toBe(3);
    expect(await countRecords(salesB, filters())).toBe(2);
    expect(await countRecords(admin, filters())).toBe(5);
  });

  it('shows an admin and an approver everything', async () => {
    expect(await appsNosFor(admin)).toHaveLength(5);
    expect(await appsNosFor(approver)).toHaveLength(5);
  });
});

describe('no filter parameter can widen a sales user scope', () => {
  it('ignores ?smId= at the parse layer', async () => {
    const parsed = parseRecordFilters({ smId: B }, salesA);
    expect(parsed.smId).toBeNull();
    expect(await appsNosFor(salesA, parsed)).toHaveLength(3);
  });

  it('still refuses when the SM_ID filter is forced past the parser', async () => {
    // Simulates a refactor that stops stripping smId for sales users. The
    // scoped predicate is ANDed, so the worst outcome is an empty list — never
    // another rep's rows.
    expect(await appsNosFor(salesA, filters({ smId: B }))).toEqual([]);
  });

  it('does not leak another rep through a search term', async () => {
    expect(await appsNosFor(salesA, filters({ q: 'Zoya' }))).toEqual([]);
    expect(await appsNosFor(salesA, filters({ q: 'Bharat Rep' }))).toEqual([]);
    expect(await appsNosFor(salesA, filters({ q: '6167509581' }))).toEqual([]);
  });

  it('does not leak another rep through the preserved extra columns', async () => {
    // `extra` is searchable (section 9.1) and holds receipt numbers. The search
    // predicate is ORed internally but ANDed with the scope, so it cannot reach
    // outside the rep's book.
    expect(await appsNosFor(salesA, filters({ q: 'SECRET-RECEIPT-9' }))).toEqual([]);
    expect(await appsNosFor(admin, filters({ q: 'SECRET-RECEIPT-9' }))).toEqual(['6167509581']);
  });

  it('does not leak another rep through the batch filter', async () => {
    expect(await appsNosFor(salesA, filters({ batchId }))).toHaveLength(3);
  });

  it('does not leak another rep through the gap filter', async () => {
    const gapRows = await appsNosFor(salesA, filters({ gap: 'ANY' }));
    expect(gapRows).toEqual(['6167509572']);
    expect(gapRows).not.toContain('6167509581');
  });

  it('does not leak another rep through the status filter', async () => {
    expect(await appsNosFor(salesA, filters({ status: 'REJECTED' }))).toEqual([]);
  });

  it('does not leak another rep through the correction-status filter', async () => {
    const [otherRecord] = await db
      .select()
      .from(salesRecord)
      .where(eq(salesRecord.appsNo, '6167509581'));
    await db.insert(correctionRequest).values({
      recordId: otherRecord.id,
      appsNo: otherRecord.appsNo,
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      proposedValue: 'Yes',
      submittedBy: salesB.id,
      smId: B,
      status: 'PENDING',
    });

    expect(await appsNosFor(salesA, filters({ correctionStatus: 'PENDING' }))).toEqual([]);
    expect(await appsNosFor(admin, filters({ correctionStatus: 'PENDING' }))).toEqual([
      '6167509581',
    ]);
  });
});

describe('the detail lookup is a 404, not a 403', () => {
  it('returns null for another rep application', async () => {
    // Null so the page renders notFound(). Distinguishing "not yours" from
    // "does not exist" would confirm the application is real — section 4.4
    // applies the same rule to proof attachments.
    expect(await getRecord(salesA, '6167509581')).toBeNull();
  });

  it('returns null for an Apps_No that does not exist at all', async () => {
    expect(await getRecord(salesA, '9999999999')).toBeNull();
  });

  it('returns the record when it is the user own', async () => {
    const record = await getRecord(salesA, '6167509571');
    expect(record?.smId).toBe(A);
  });

  it('lets an admin read any record', async () => {
    expect((await getRecord(admin, '6167509581'))?.smId).toBe(B);
  });
});

describe('the version chain is scoped through its join', () => {
  beforeEach(async () => {
    const rows = await db.select().from(salesRecord);
    await db.insert(salesRecordVersion).values(
      rows.map((r) => ({
        recordId: r.id,
        version: 1,
        data: { appsNo: r.appsNo, smId: r.smId, clientName: r.clientName },
        changeType: 'IMPORT' as const,
      })),
    );
  });

  it('returns nothing for another rep application', async () => {
    // A version row carries a full snapshot, so an unscoped read here would
    // hand over every field of a record the list query correctly hides.
    expect(await listRecordVersions(salesA, '6167509581')).toEqual([]);
  });

  it('returns the chain for the user own record', async () => {
    const versions = await listRecordVersions(salesA, '6167509571');
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
  });

  it('lets an admin read any chain', async () => {
    expect(await listRecordVersions(admin, '6167509581')).toHaveLength(1);
  });
});

describe('filter dropdowns are scoped too', () => {
  it('gives a sales user no SM_ID roster at all', async () => {
    // Not a scope leak — the filter could not widen anything — but the list of
    // other reps IDs is information a rep has no reason to hold.
    expect(await listSmIdOptions(salesA)).toEqual([]);
    expect(await listSmIdOptions(approver)).toEqual([]);
    expect((await listSmIdOptions(admin)).map((o) => o.smId)).toEqual([B, A]);
  });

  it('offers only statuses present in the user own records', async () => {
    expect(await listStatusOptions(salesA)).toEqual(['ISSUED', 'PENDING']);
    expect(await listStatusOptions(salesB)).toEqual(['ISSUED', 'REJECTED']);
  });

  it('offers only batches that produced the user own records', async () => {
    expect(await listBatchOptions(salesA)).toEqual([{ id: batchId, label: 'june.xlsb' }]);
  });
});

describe('a sales session with no SM_ID fails closed', () => {
  const unscopable: SessionUser = {
    id: 'ghost',
    email: 'ghost@example.test',
    name: 'Ghost',
    role: 'sales',
    smId: null,
    isActive: true,
  };

  it('throws rather than running an unfiltered query', async () => {
    // A database CHECK makes this account impossible to create, so this is the
    // belt to that braces: if one ever existed, the query must refuse rather
    // than quietly return every record in the system.
    await expect(listRecords(unscopable, filters(), PAGE)).rejects.toBeInstanceOf(AuthzError);
    await expect(countRecords(unscopable, filters())).rejects.toBeInstanceOf(AuthzError);
    await expect(getRecord(unscopable, '6167509571')).rejects.toBeInstanceOf(AuthzError);
    await expect(listRecordVersions(unscopable, '6167509571')).rejects.toBeInstanceOf(AuthzError);
  });
});
