import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { Workbook, type Worksheet } from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  auditLog,
  correctionRequest,
  excelExport,
  notification,
  period,
  salesRecord,
  uploadBatch,
} from '@/db/schema';
import { SHEET_CORRECTIONS, SHEET_MASTER } from '@/lib/export/build';
import { runExport } from '@/lib/export/service';
import { NO_FILTERS } from '@/lib/export/schemas';
import { resolveStoredPath } from '@/lib/storage/paths';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The generation pipeline end to end: real rows in, a real file on disk, and
 * the `excel_export` row that has to describe it.
 *
 * runExport takes the actor as an argument rather than reading a session, so
 * the authorization check stays on the Server Action and the Route Handler
 * where spec 4.1 puts it — and this suite can exercise the pipeline without
 * one.
 */

const OWNER_A = 'C2CM21350';
const OWNER_B = 'C2CM21351';

let admin: Awaited<ReturnType<typeof makeUser>>;
let approver: Awaited<ReturnType<typeof makeUser>>;
let verifier: Awaited<ReturnType<typeof makeUser>>;
let sales: Awaited<ReturnType<typeof makeUser>>;
let batchId: string;
let periodId: string;
let correctedRecordId: string;
const written: string[] = [];

async function seed() {
  await truncateAll();

  admin = await makeUser({ role: 'admin', name: 'Admin One', email: 'admin@example.test' });
  approver = await makeUser({
    role: 'approver',
    name: 'Anita Approver',
    email: 'anita@example.test',
  });
  verifier = await makeUser({
    role: 'verifier',
    name: 'Vikram Verifier',
    email: 'vikram@example.test',
  });
  sales = await makeUser({
    role: 'sales',
    name: 'Ravi Sales',
    email: 'ravi@example.test',
    smId: OWNER_A,
  });

  const [june] = await db
    .insert(period)
    .values({
      code: '2026-06',
      label: 'Jun 2026',
      startsOn: '2026-06-01',
      endsOn: '2026-06-30',
    })
    .returning({ id: period.id });
  periodId = june.id;

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: 'June Login Data.xlsb',
      storedPath: `uploads/2026/06/${randomUUID()}.xlsb`,
      fileHash: 'a'.repeat(64),
      status: 'COMMITTED',
      uploadedBy: admin.id,
      committedBy: admin.id,
      committedAt: new Date('2026-07-01T00:00:00.000Z'),
    })
    .returning({ id: uploadBatch.id });
  batchId = batch.id;

  const [corrected] = await db
    .insert(salesRecord)
    .values([
      {
        appsNo: '5920000001',
        policyNo: '0412345678',
        clientName: 'Ravi Kumar',
        smId: OWNER_A,
        smName: 'Asha Rao',
        issuedDate: '2026-06-03',
        fp: '4195.42',
        anp: '120000.50',
        status: 'ISSUED',
        autopay: 'Yes',
        extra: { FY: '2026-27', Source: 'Digital' },
        // The other two rows keep a null period, so the export has to resolve
        // this one through the lookup rather than stamping every row alike.
        periodId,
        sourceBatchId: batchId,
        hasCorrections: true,
        currentVersion: 2,
      },
      {
        appsNo: '5920000002',
        clientName: 'Sunita Devi',
        smId: OWNER_A,
        smName: 'Asha Rao',
        issuedDate: '2026-06-20',
        fp: '500.00',
        status: 'ISSUED',
        extra: { FY: '2026-27', 'LA Occupation': 'Salaried' },
        sourceBatchId: batchId,
      },
      {
        appsNo: '5920000003',
        clientName: 'Mohan Lal',
        smId: OWNER_B,
        smName: 'Bela Nair',
        issuedDate: null,
        status: 'PENDING',
        extra: {},
        sourceBatchId: batchId,
      },
    ])
    .returning({ id: salesRecord.id, appsNo: salesRecord.appsNo });
  correctedRecordId = corrected.id;

  await db.insert(correctionRequest).values([
    // The only row that reached the record: raised, verified, then approved —
    // the full path of 2026-07-28 spec section 3, so the log has both reviewers
    // to name.
    {
      recordId: correctedRecordId,
      appsNo: '5920000001',
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      originalValue: null,
      proposedValue: 'Yes',
      description: 'NACH mandate registered.',
      submittedBy: sales.id,
      smId: OWNER_A,
      periodId,
      status: 'APPROVED',
      verifiedBy: verifier.id,
      verifiedAt: new Date('2026-06-30T06:00:00.000Z'),
      verifierRemarks: 'Mandate copy matches the application.',
      reviewedBy: approver.id,
      reviewedAt: new Date('2026-07-01T09:30:00.000Z'),
      approverRemarks: 'Mandate copy verified.',
      appliedAt: new Date('2026-07-01T09:30:00.000Z'),
      appliedVersion: 2,
    },
    // Verified but not yet decided. It sits in the approver's queue and has
    // changed nothing on the record — clearing the first gate must not be
    // enough to put a row in the log.
    {
      recordId: correctedRecordId,
      appsNo: '5920000001',
      category: 'OTHERS',
      fieldName: 'policyNo',
      fieldLabel: 'Policy number',
      originalValue: '0412345678',
      proposedValue: '0412345679',
      description: 'Digit transposed against the policy bond.',
      submittedBy: sales.id,
      smId: OWNER_A,
      periodId,
      status: 'VERIFIED',
      verifiedBy: verifier.id,
      verifiedAt: new Date('2026-07-02T06:00:00.000Z'),
      verifierRemarks: 'Bond copy attached.',
    },
    // Still pending: it has changed nothing on the record, so it must not
    // appear in the log or highlight a cell that still holds the source value.
    {
      recordId: correctedRecordId,
      appsNo: '5920000001',
      category: 'OTHERS',
      fieldName: 'clientName',
      fieldLabel: 'Client name',
      originalValue: 'Ravi Kumar',
      proposedValue: 'Ravi Kumar Singh',
      description: 'Name per PAN card.',
      submittedBy: sales.id,
      smId: OWNER_A,
      periodId,
      status: 'PENDING',
    },
  ]);
}

/**
 * Reads a cell by its header text rather than by position.
 *
 * Column order is not part of what this suite is asserting, and a positional
 * read makes every test here fail the next time a column is inserted — as
 * `Period` and the verifier columns just were — for a reason that has nothing to
 * do with the pipeline these tests exist to cover.
 */
function cellAt(sheet: Worksheet, rowNumber: number, header: string) {
  const headers = sheet.getRow(1).values as unknown[];
  const column = headers.findIndex((value) => value === header);
  if (column < 0) throw new Error(`No column "${header}" in ${sheet.name}`);
  return sheet.getRow(rowNumber).getCell(column);
}

async function readGenerated(storedPath: string): Promise<Workbook> {
  const absolute = resolveStoredPath(storedPath);
  written.push(absolute);
  const workbook = new Workbook();
  await workbook.xlsx.readFile(absolute);
  return workbook;
}

beforeAll(async () => {
  await seed();
  return async () => {
    await Promise.all(written.map((p) => rm(p, { force: true })));
  };
});

describe('runExport records what it produced (spec 5.10)', () => {
  it('writes a file whose sha256 is the one stored on the row', async () => {
    const generated = await runExport(admin, NO_FILTERS, new Date('2026-07-27T10:15:00.000Z'));

    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    expect(row.fileName).toBe(generated.fileName);
    expect(row.rowCount).toBe(3);
    expect(row.correctionCount).toBe(1);
    expect(row.downloadCount).toBe(0);
    expect(row.requestedBy).toBe(admin.id);

    const bytes = await readFile(resolveStoredPath(row.storedPath));
    written.push(resolveStoredPath(row.storedPath));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(row.sha256);
    expect(row.sha256).toBe(generated.sha256);
  });

  it('names the file to the pattern spec 8 fixes and increments the version', async () => {
    const first = await runExport(admin, NO_FILTERS);
    const second = await runExport(admin, NO_FILTERS);

    expect(first.fileName).toMatch(/^sales-reconciliation-\d{8}-\d{4}-v\d+\.xlsx$/);
    const version = (name: string) => Number(/-v(\d+)\.xlsx$/.exec(name)![1]);
    expect(version(second.fileName)).toBe(version(first.fileName) + 1);
  });

  it('audits the generation and notifies the requesting admin', async () => {
    const generated = await runExport(admin, NO_FILTERS);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'EXPORT_GENERATE'), eq(auditLog.entityId, generated.id)));

    expect(audits).toHaveLength(1);
    expect(audits[0].actorId).toBe(admin.id);
    expect(audits[0].entityType).toBe('excel_export');
    expect(audits[0].actorRole).toBe('admin');

    const notes = await db
      .select()
      .from(notification)
      .where(and(eq(notification.userId, admin.id), eq(notification.type, 'EXPORT_READY')));

    expect(notes.length).toBeGreaterThan(0);
    expect(notes.at(-1)!.link).toBe('/admin/exports');
  });
});

describe('filters narrow the row set and are persisted (spec 8)', () => {
  it('scopes to one SM_ID', async () => {
    const filters = { ...NO_FILTERS, smId: OWNER_B };
    const generated = await runExport(admin, filters);

    expect(generated.rowCount).toBe(1);

    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));
    expect(row.filters).toMatchObject({ smId: OWNER_B, correctedOnly: false, batchId: null });

    const workbook = await readGenerated(row.storedPath);
    const master = workbook.getWorksheet(SHEET_MASTER)!;
    expect(master.actualRowCount).toBe(2); // header + one record
    expect(master.getRow(2).getCell(1).value).toBe('5920000003');
  });

  it('scopes to corrected records only', async () => {
    const generated = await runExport(admin, { ...NO_FILTERS, correctedOnly: true });

    expect(generated.rowCount).toBe(1);
    expect(generated.correctionCount).toBe(1);

    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));
    expect(row.filters).toMatchObject({ correctedOnly: true });
  });

  it('bounds by issued date, which drops records with no issuance date', async () => {
    // The PENDING record has no issued_date, so a bounded export cannot contain
    // it — it was never issued in the window the workbook claims to cover.
    const generated = await runExport(admin, {
      ...NO_FILTERS,
      issuedFrom: '2026-06-01',
      issuedTo: '2026-06-10',
    });

    expect(generated.rowCount).toBe(1);
  });

  it('scopes to one batch', async () => {
    const generated = await runExport(admin, { ...NO_FILTERS, batchId });
    expect(generated.rowCount).toBe(3);

    const other = await runExport(admin, { ...NO_FILTERS, batchId: randomUUID() });
    expect(other.rowCount).toBe(0);
  });
});

describe('the generated file reflects the database (spec 8)', () => {
  it('logs only applied corrections, never a pending or merely verified one', async () => {
    const generated = await runExport(admin, NO_FILTERS);
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const log = (await readGenerated(row.storedPath)).getWorksheet(SHEET_CORRECTIONS)!;

    expect(log.actualRowCount).toBe(2); // header + the one APPROVED request
    expect(cellAt(log, 2, 'Apps_No').value).toBe('5920000001');
    expect(cellAt(log, 2, 'Field').value).toBe('AutoPay');
    expect(cellAt(log, 2, 'Approved_Value').value).toBe('Yes');
    expect(cellAt(log, 2, 'Approver').value).toBe('Anita Approver');
  });

  it('names the verifier who cleared the row, from the user the request points at', async () => {
    const generated = await runExport(admin, NO_FILTERS);
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const log = (await readGenerated(row.storedPath)).getWorksheet(SHEET_CORRECTIONS)!;

    // The verifier reaches the sheet through its own join, not through the
    // reviewer one — an export that resolved both from `reviewed_by` would print
    // the approver's name in both columns and still look plausible.
    expect(cellAt(log, 2, 'Verifier').value).toBe('Vikram Verifier');
    expect((cellAt(log, 2, 'Verified_On').value as Date).toISOString()).toBe(
      '2026-06-30T06:00:00.000Z',
    );
    expect(cellAt(log, 2, 'Verifier_Remarks').value).toBe('Mandate copy matches the application.');
    expect(cellAt(log, 2, 'Period').value).toBe('Jun 2026');
  });

  it('resolves the period label for the records that carry one', async () => {
    const generated = await runExport(admin, NO_FILTERS);
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const master = (await readGenerated(row.storedPath)).getWorksheet(SHEET_MASTER)!;

    // Rows are ordered by Apps_No, so 5920000001 — the only record in a period —
    // is row 2 and the two pre-period rows follow it.
    expect(cellAt(master, 2, 'Period').value).toBe('Jun 2026');
    expect(cellAt(master, 3, 'Period').value).toBeFalsy();
  });

  it('preserves money and identifiers read straight out of Postgres', async () => {
    const generated = await runExport(admin, { ...NO_FILTERS, smId: OWNER_A });
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const master = (await readGenerated(row.storedPath)).getWorksheet(SHEET_MASTER)!;

    expect(cellAt(master, 2, 'Application number').value).toBe('5920000001');
    expect(cellAt(master, 2, 'FP (first premium)').value).toBe(4195.42);
  });

  it('unions extra columns across the exported rows', async () => {
    const generated = await runExport(admin, { ...NO_FILTERS, smId: OWNER_A });
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const master = (await readGenerated(row.storedPath)).getWorksheet(SHEET_MASTER)!;
    const headers = (master.getRow(1).values as unknown[]).slice(1) as string[];

    expect(headers).toContain('FY');
    expect(headers).toContain('Source');
    expect(headers).toContain('LA Occupation');
  });
});
