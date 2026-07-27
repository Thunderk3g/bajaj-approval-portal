import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditLog,
  correctionRequest,
  manpower,
  notification,
  salesRecord,
  salesRecordVersion,
  uploadBatch,
  uploadBatchRow,
} from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { commitBatch } from '@/lib/import/commit';
import { suggestMapping } from '@/lib/import/mapping';
import { readSheet } from '@/lib/import/parse';
import { loadMasterSnapshots, stageRows } from '@/lib/import/stage';
import type { ValidationReport } from '@/lib/import/types';
import { buildValidationReport, validateRows } from '@/lib/import/validate';
import { allocateStoragePath, ensureStorageDirs, UPLOADS_DIR } from '@/lib/storage/paths';
import { makeUser, truncateAll } from '../helpers/db';
import { APPS, fixtureBuffer, SM } from '../fixtures/workbook';

/**
 * The commit transaction against a real database — spec sections 6.6, 6.7, 6.8.
 *
 * The re-import tests are the ones that matter most. Silently reverting an
 * approved, evidenced correction because someone re-uploaded a stale export is
 * the most damaging failure this system could have, and it is exactly the kind
 * of regression a refactor introduces without breaking anything visible.
 */

const FILE_NAME = "Businesses Dashboard Jun'26.xlsb";

function sessionUser(row: { id: string; email: string; name: string; role: string; smId: string | null }): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

/**
 * Runs everything an admin would do through the UI up to the commit gate:
 * store the file, choose the sheet, accept the suggested mapping, validate and
 * stage. Deliberately calls the same pipeline functions the Server Actions do,
 * so a divergence between preview and commit would show up here.
 */
async function createValidatedBatch(adminId: string): Promise<{ batchId: string; report: ValidationReport }> {
  const bytes = fixtureBuffer('xlsb');
  const fileHash = createHash('sha256').update(bytes).digest('hex');

  await ensureStorageDirs();
  const { absolutePath, relativePath } = await allocateStoragePath(UPLOADS_DIR, 'xlsb');
  await writeFile(absolutePath, bytes);

  const sheet = readSheet(bytes, { sheetName: 'Login Data' });
  const { mapping } = suggestMapping(sheet.columns);

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: FILE_NAME,
      storedPath: relativePath,
      fileHash,
      sheetName: 'Login Data',
      headerRow: 1,
      dateFormat: 'dd/MM/yyyy',
      columnMapping: mapping,
      uploadedBy: adminId,
    })
    .returning({ id: uploadBatch.id });

  const firstPass = validateRows(sheet.rows, { columns: sheet.columns, mapping });
  const appsNos = firstPass.rows.map((r) => r.normalized.appsNo).filter((v): v is string => Boolean(v));
  const existing = await loadMasterSnapshots(appsNos);

  const outcome = validateRows(sheet.rows, { columns: sheet.columns, mapping, existing });
  const report = buildValidationReport(outcome, { sheet, dateFormat: 'dd/MM/yyyy', mapping });

  await stageRows(batch.id, outcome.rows);
  await db
    .update(uploadBatch)
    .set({
      status: 'VALIDATED',
      totalRows: report.totals.rows,
      validRows: report.totals.valid,
      invalidRows: report.totals.invalid,
      duplicateRows: report.totals.duplicate,
      validationReport: report,
    })
    .where(eq(uploadBatch.id, batch.id));

  return { batchId: batch.id, report };
}

async function recordFor(appsNo: string) {
  const [row] = await db.select().from(salesRecord).where(eq(salesRecord.appsNo, appsNo));
  return row;
}

describe('batch commit', () => {
  let admin: SessionUser;

  beforeEach(async () => {
    await truncateAll();
    admin = sessionUser(await makeUser({ role: 'admin', name: 'Import Admin' }));
  });

  it('inserts the valid rows and writes version 1 as the untouched import', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    const outcome = await commitBatch({ batchId, actor: admin });

    expect(outcome.inserted).toBe(7);
    expect(outcome.updated).toBe(0);

    const record = await recordFor(APPS.ISSUED_COMPLETE);
    expect(record.smId).toBe(SM.SPLIT_CASE);
    expect(record.issuedDate).toBe('2026-06-03');
    expect(record.fp).toBe('4195.42');
    expect(record.currentVersion).toBe(1);

    const versions = await db
      .select()
      .from(salesRecordVersion)
      .where(eq(salesRecordVersion.recordId, record.id));
    expect(versions).toHaveLength(1);
    expect(versions[0].changeType).toBe('IMPORT');
    expect(versions[0].version).toBe(1);
    expect(versions[0].batchId).toBe(batchId);
  });

  it('stores Apps_No as full-length text, never in scientific notation', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    await commitBatch({ batchId, actor: admin });

    const records = await db.select({ appsNo: salesRecord.appsNo }).from(salesRecord);
    expect(records).toHaveLength(7);
    for (const record of records) {
      expect(record.appsNo).toMatch(/^\d{10}$/);
      expect(record.appsNo).not.toMatch(/[eE]/);
    }
  });

  it('holds back the error rows and the duplicate rather than dropping them silently', async () => {
    const { batchId, report } = await createValidatedBatch(admin.id);
    await commitBatch({ batchId, actor: admin });

    // The three error rows and the one duplicate are named with their worksheet
    // row numbers, so an admin can find them in Excel.
    expect(report.skippedRowNumbers).toEqual([7, 8, 9, 11]);
    expect(report.duplicates).toEqual([
      { rowNumber: 7, appsNo: APPS.ISSUED_COMPLETE, duplicateOfRow: 2 },
    ]);

    const staged = await db
      .select({ rowNumber: uploadBatchRow.rowNumber, status: uploadBatchRow.status })
      .from(uploadBatchRow)
      .where(eq(uploadBatchRow.batchId, batchId));

    const byRow = new Map(staged.map((r) => [r.rowNumber, r.status]));
    expect(byRow.get(7)).toBe('DUPLICATE');
    expect(byRow.get(8)).toBe('INVALID');
    expect(byRow.get(2)).toBe('COMMITTED');

    // The duplicate did not create a second record.
    const duplicates = await db
      .select()
      .from(salesRecord)
      .where(eq(salesRecord.appsNo, APPS.ISSUED_COMPLETE));
    expect(duplicates).toHaveLength(1);
  });

  it('preserves unmapped columns instead of discarding them', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    await commitBatch({ batchId, actor: admin });

    const record = await recordFor(APPS.ISSUED_COMPLETE);
    expect(record.extra).toMatchObject({ FY: 'FY26' });
    // The literal "-" is absence, not data, and must not be stored as a value.
    expect(record.extra).not.toHaveProperty('Source');
  });

  it('upserts the roster and flags an SM_ID that only exists in transaction data', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    const outcome = await commitBatch({ batchId, actor: admin });

    expect(outcome.orphanSmIds).toEqual([SM.ORPHAN_NUMERIC]);

    const [orphan] = await db.select().from(manpower).where(eq(manpower.smId, SM.ORPHAN_NUMERIC));
    expect(orphan.isOrphan).toBe(true);

    const [known] = await db.select().from(manpower).where(eq(manpower.smId, SM.SPLIT_CASE));
    expect(known.isOrphan).toBe(false);
    expect(known.smName).toBe('Ravi Kumar');
  });

  it('carries Mapping Changes Latest in as a pre-approved correction with provenance', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    const outcome = await commitBatch({ batchId, actor: admin });

    // One pair names an application in this file; the other is a prior-month
    // application this database has never seen, which is counted, not lost.
    expect(outcome.mappingChangesApplied).toBe(1);
    expect(outcome.mappingChangesUnmatched).toBe(1);

    const record = await recordFor(APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY);
    expect(record.smId).toBe(SM.GAP_REP);
    // sm_id and sm_name are never allowed to diverge: the name comes from the
    // roster, not from the sheet.
    expect(record.smName).toBe('Sunil Rao');
    expect(record.hasCorrections).toBe(true);

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.recordId, record.id));

    expect(request.category).toBe('MAPPING');
    expect(request.status).toBe('APPROVED');
    expect(request.fieldName).toBe('smId');
    expect(request.originalValue).toBe(SM.SPLIT_CASE);
    expect(request.proposedValue).toBe(SM.GAP_REP);
    expect(request.submittedBy).toBe(admin.id);
    expect(request.appliedVersion).toBe(record.currentVersion);
  });

  it('notifies the sales users whose SM_ID appears in the batch, with their gap count', async () => {
    const sales = await makeUser({ role: 'sales', smId: SM.SPLIT_CASE, name: 'Ravi Kumar' });
    const { batchId } = await createValidatedBatch(admin.id);

    const outcome = await commitBatch({ batchId, actor: admin });
    expect(outcome.notified).toBe(1);

    const [row] = await db.select().from(notification).where(eq(notification.userId, sales.id));
    expect(row.type).toBe('BATCH_COMMITTED');
    expect(row.body).toContain('1 of your records');
  });

  it('marks the batch committed and writes exactly one UPLOAD_COMMIT audit row', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    await commitBatch({ batchId, actor: admin });

    const [batch] = await db.select().from(uploadBatch).where(eq(uploadBatch.id, batchId));
    expect(batch.status).toBe('COMMITTED');
    expect(batch.committedBy).toBe(admin.id);
    expect(batch.committedAt).toBeInstanceOf(Date);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'UPLOAD_COMMIT'), eq(auditLog.entityId, batchId)));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorEmail).toBe(admin.email);
  });

  it('refuses to commit a batch that is not validated', async () => {
    const { batchId } = await createValidatedBatch(admin.id);
    await db.update(uploadBatch).set({ status: 'DRAFT' }).where(eq(uploadBatch.id, batchId));

    await expect(commitBatch({ batchId, actor: admin })).rejects.toThrow(/validated/i);
  });
});

describe('re-import conflict policy — spec 6.8', () => {
  let admin: SessionUser;
  let sales: SessionUser;

  beforeEach(async () => {
    await truncateAll();
    admin = sessionUser(await makeUser({ role: 'admin', name: 'Import Admin' }));
    sales = sessionUser(await makeUser({ role: 'sales', smId: SM.SPLIT_CASE, name: 'Ravi Kumar' }));

    const { batchId } = await createValidatedBatch(admin.id);
    await commitBatch({ batchId, actor: admin });
  });

  /** An approved, evidenced correction: the issuance date was wrong in the file. */
  async function approveIssuedDateCorrection(): Promise<string> {
    const record = await recordFor(APPS.ISSUED_COMPLETE);

    await db.insert(correctionRequest).values({
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'ISSUANCE_DATE',
      fieldName: 'issuedDate',
      fieldLabel: 'Issued date',
      originalValue: '2026-06-03',
      proposedValue: '2026-06-30',
      submittedBy: sales.id,
      smId: SM.SPLIT_CASE,
      status: 'APPROVED',
      reviewedBy: admin.id,
      reviewedAt: new Date(),
      appliedAt: new Date(),
      appliedVersion: 2,
    });

    await db
      .update(salesRecord)
      .set({ issuedDate: '2026-06-30', hasCorrections: true, currentVersion: 2 })
      .where(eq(salesRecord.id, record.id));

    return record.id;
  }

  it('keeps the approved value when a stale export disagrees', async () => {
    const recordId = await approveIssuedDateCorrection();

    const { batchId, report } = await createValidatedBatch(admin.id);

    // The disagreement is visible on the review screen before anything is
    // written — the admin decides, not whoever uploaded last.
    expect(report.conflicts).toContainEqual(
      expect.objectContaining({
        appsNo: APPS.ISSUED_COMPLETE,
        field: 'issuedDate',
        currentValue: '2026-06-30',
        incomingValue: '2026-06-03',
      }),
    );

    const outcome = await commitBatch({ batchId, actor: admin });
    expect(outcome.conflictsHeld).toBeGreaterThanOrEqual(1);
    expect(outcome.conflictsResolved).toBe(0);

    const after = await recordFor(APPS.ISSUED_COMPLETE);
    expect(after.issuedDate).toBe('2026-06-30');
    expect(after.id).toBe(recordId);

    // No REIMPORT version was written for a change that never happened.
    const versions = await db
      .select()
      .from(salesRecordVersion)
      .where(eq(salesRecordVersion.recordId, recordId));
    expect(versions.map((v) => v.changeType)).toEqual(['IMPORT']);
  });

  it('applies the file value only when the admin explicitly accepts it', async () => {
    const recordId = await approveIssuedDateCorrection();
    const { batchId } = await createValidatedBatch(admin.id);

    const outcome = await commitBatch({
      batchId,
      actor: admin,
      acceptedConflicts: { [APPS.ISSUED_COMPLETE]: ['issuedDate'] },
    });

    expect(outcome.conflictsResolved).toBe(1);

    const after = await recordFor(APPS.ISSUED_COMPLETE);
    expect(after.issuedDate).toBe('2026-06-03');
    expect(after.currentVersion).toBe(3);

    const versions = await db
      .select()
      .from(salesRecordVersion)
      .where(eq(salesRecordVersion.recordId, recordId));
    const reimport = versions.find((v) => v.changeType === 'REIMPORT')!;
    expect(reimport.changedFields).toEqual(['issuedDate']);
    expect(reimport.changedBy).toBe(admin.id);

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'RECORD_CONFLICT_RESOLVE'), eq(auditLog.entityId, recordId)));
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ field: 'issuedDate', value: '2026-06-30' });
    expect(audits[0].after).toMatchObject({ field: 'issuedDate', value: '2026-06-03' });
  });

  it('protects a reassignment that came in from Mapping Changes Latest', async () => {
    // The first commit moved 5920000002 to another rep and recorded that as an
    // approved MAPPING correction. Re-importing the same file must not put it
    // back, even though the file still credits the original rep.
    const before = await recordFor(APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY);
    expect(before.smId).toBe(SM.GAP_REP);

    const { batchId, report } = await createValidatedBatch(admin.id);
    expect(report.conflicts).toContainEqual(
      expect.objectContaining({
        appsNo: APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY,
        field: 'smId',
        currentValue: SM.GAP_REP,
        incomingValue: SM.SPLIT_CASE,
      }),
    );

    await commitBatch({ batchId, actor: admin });

    const after = await recordFor(APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY);
    expect(after.smId).toBe(SM.GAP_REP);
  });

  it('updates a field that carries no approved correction', async () => {
    const record = await recordFor(APPS.ISSUED_COMPLETE);
    await db
      .update(salesRecord)
      .set({ clientName: 'Stale Name' })
      .where(eq(salesRecord.id, record.id));

    const { batchId } = await createValidatedBatch(admin.id);
    const outcome = await commitBatch({ batchId, actor: admin });

    expect(outcome.updated).toBeGreaterThanOrEqual(1);
    const after = await recordFor(APPS.ISSUED_COMPLETE);
    expect(after.clientName).toBe('Test Client');
  });

  it('never deletes a record that is absent from the new file', async () => {
    await db.insert(salesRecord).values({
      appsNo: '5910000099',
      smId: 'C2CM11111',
      clientName: 'Prior month client',
      status: 'ISSUED',
    });

    const { batchId } = await createValidatedBatch(admin.id);
    await commitBatch({ batchId, actor: admin });

    const survivor = await recordFor('5910000099');
    expect(survivor).toBeDefined();
    expect(survivor.clientName).toBe('Prior month client');
  });
});
