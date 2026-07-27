import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { Workbook } from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import {
  auditLog,
  correctionRequest,
  excelExport,
  notification,
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
let sales: Awaited<ReturnType<typeof makeUser>>;
let batchId: string;
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
  sales = await makeUser({
    role: 'sales',
    name: 'Ravi Sales',
    email: 'ravi@example.test',
    smId: OWNER_A,
  });

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
      status: 'APPROVED',
      reviewedBy: approver.id,
      reviewedAt: new Date('2026-07-01T09:30:00.000Z'),
      approverRemarks: 'Mandate copy verified.',
      appliedAt: new Date('2026-07-01T09:30:00.000Z'),
      appliedVersion: 2,
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
      status: 'PENDING',
    },
  ]);
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
  it('logs only applied corrections, never a pending one', async () => {
    const generated = await runExport(admin, NO_FILTERS);
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const log = (await readGenerated(row.storedPath)).getWorksheet(SHEET_CORRECTIONS)!;

    expect(log.actualRowCount).toBe(2); // header + the one APPROVED request
    expect(log.getRow(2).getCell(1).value).toBe('5920000001');
    expect(log.getRow(2).getCell(2).value).toBe('AutoPay');
    expect(log.getRow(2).getCell(4).value).toBe('Yes');
    expect(log.getRow(2).getCell(10).value).toBe('Anita Approver');
  });

  it('preserves money and identifiers read straight out of Postgres', async () => {
    const generated = await runExport(admin, { ...NO_FILTERS, smId: OWNER_A });
    const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

    const master = (await readGenerated(row.storedPath)).getWorksheet(SHEET_MASTER)!;
    const headers = master.getRow(1).values as unknown[];
    const fpColumn = headers.findIndex((h) => h === 'FP (first premium)');

    expect(master.getRow(2).getCell(1).value).toBe('5920000001');
    expect(master.getRow(2).getCell(fpColumn).value).toBe(4195.42);
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
