/**
 * The reported failure, end to end: "a TL or an ACM raises a request for their
 * SM, the request is accepted, and the change is not in the export."
 *
 * Every hop the real workflow makes is a real hop here — import the workbook,
 * raise through `submitCorrection` as a MANAGER, clear the chain through
 * `verifyRequest` and `applyApproval`, re-import the SAME workbook (which still
 * carries the old value), then generate the actual export file and read the
 * cells back out of it. Anything short of that could pass while the bug is live:
 * the record write is provably correct in isolation, so if the corrected value
 * disappears it disappears somewhere between the write and the reader.
 *
 * AUTOPAY and MAPPING specifically, because those are the two categories where
 * the request's `field_name` text and the column the approval actually writes
 * could come apart — the category pins the field and `field_name` is ignored at
 * apply time, while the re-import used to read `field_name` alone to decide what
 * to protect. If the two ever disagree, a stale workbook silently reverts an
 * approved, evidenced correction, which is spec 6.8's whole subject.
 */

import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { Workbook, type Worksheet } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, excelExport, salesRecord, uploadBatch } from '@/db/schema';
import { applyApproval } from '@/lib/approvals/apply';
import type { SessionUser } from '@/lib/auth/rbac';
import { submitCorrection } from '@/lib/corrections/service';
import { SHEET_MASTER } from '@/lib/export/build';
import { NO_FILTERS } from '@/lib/export/schemas';
import { runExport } from '@/lib/export/service';
import { fieldLabel } from '@/lib/fields';
import { commitBatch, commitRoster } from '@/lib/import/commit';
import { suggestMapping } from '@/lib/import/mapping';
import { readSheet } from '@/lib/import/parse';
import { loadMasterSnapshots, stageRows } from '@/lib/import/stage';
import { buildValidationReport, validateRows } from '@/lib/import/validate';
import type { ValidationReport } from '@/lib/import/types';
import {
  allocateStoragePath,
  ensureStorageDirs,
  resolveStoredPath,
  UPLOADS_DIR,
} from '@/lib/storage/paths';
import { verifyRequest } from '@/lib/verification/apply';
import { makeUser, truncateAll } from '../helpers/db';
import { APPS, fixtureBuffer, SM } from '../fixtures/workbook';

/**
 * Fixture roster (`tests/fixtures/workbook.ts`):
 *   C2CM21350 Ravi Kumar   TL001 / CCM01
 *   C2CM99999 Anita Desai  TL002 / CCM01
 * So TL001 owns one rep, and CCM01 spans both teams — which is what lets the
 * ACM claim a sale from one of their reps into the other.
 */
const AUTOPAY_APPS = APPS.ISSUED_COMPLETE; // C2CM21350, AutoPay "Y" in the sheet
const MAPPING_APPS = APPS.REJECTED; // C2CM99999 in the sheet

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const proof = () => ({ name: 'mandate.png', bytes: new Uint8Array(PNG) });

let admin: SessionUser;
let verifier: SessionUser;
let approver: SessionUser;
let tl: SessionUser;
let acm: SessionUser;

const written: string[] = [];

function sessionOf(row: Awaited<ReturnType<typeof makeUser>>): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    smId: row.smId,
    tlCode: row.tlCode,
    acmCode: row.acmCode,
    isActive: true,
  };
}

/**
 * Everything an admin does through the UI up to and including the commit: store
 * the file, accept the suggested mapping, validate against what is already
 * stored, stage, commit the roster, commit the policies.
 *
 * Deliberately the same pipeline functions the Server Actions call. Running it
 * twice with the same bytes IS the re-import — the fixture still credits the
 * original rep and still says AutoPay "Y", which is exactly the stale workbook
 * the user re-uploads every month.
 */
async function importFixture(): Promise<{ batchId: string; report: ValidationReport }> {
  const bytes = fixtureBuffer('xlsb');

  await ensureStorageDirs();
  const { absolutePath, relativePath } = await allocateStoragePath(UPLOADS_DIR, 'xlsb');
  await writeFile(absolutePath, bytes);
  written.push(absolutePath);

  const sheet = readSheet(bytes, { sheetName: 'Login Data' });
  const { mapping } = suggestMapping(sheet.columns);

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: "Businesses Dashboard Jun'26.xlsb",
      storedPath: relativePath,
      fileHash: createHash('sha256').update(bytes).digest('hex'),
      sheetName: 'Login Data',
      headerRow: 1,
      dateFormat: 'dd/MM/yyyy',
      columnMapping: mapping,
      uploadedBy: admin.id,
    })
    .returning({ id: uploadBatch.id });

  const firstPass = validateRows(sheet.rows, { columns: sheet.columns, mapping });
  const appsNos = firstPass.rows
    .map((r) => r.normalized.appsNo)
    .filter((v): v is string => Boolean(v));
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

  await commitRoster({ batchId: batch.id, actor: admin });
  await commitBatch({ batchId: batch.id, actor: admin });

  return { batchId: batch.id, report };
}

async function recordFor(appsNo: string) {
  const [row] = await db.select().from(salesRecord).where(eq(salesRecord.appsNo, appsNo));
  return row;
}

/**
 * Raises as a manager and drives the request all the way to APPROVED.
 *
 * Two decisions, not one: the bootstrap chain is verifier then approver, and the
 * record is written only by the FINAL rung. A test that stopped at the verifier
 * would be asserting the same thing the user misread as "the request is
 * accepted".
 */
async function raiseAndApprove(
  actor: SessionUser,
  input: Parameters<typeof submitCorrection>[1],
): Promise<string> {
  const submitted = await submitCorrection(actor, input);
  if (!submitted.ok) throw new Error(`submit failed: ${submitted.error}`);

  await verifyRequest({ requestId: submitted.data.id, actor: verifier, remarks: 'Proof seen.' });
  await applyApproval({ requestId: submitted.data.id, actor: approver, remarks: 'Approved.' });

  return submitted.data.id;
}

/** Reads a master-sheet cell by header text — column order is not what is under test. */
function cellText(sheet: Worksheet, rowNumber: number, header: string): string | null {
  const headers = sheet.getRow(1).values as unknown[];
  const column = headers.findIndex((value) => value === header);
  if (column < 0) throw new Error(`No column "${header}" in ${sheet.name}`);
  const value = sheet.getRow(rowNumber).getCell(column).value;
  return value === null || value === undefined ? null : String(value);
}

function rowNumberFor(sheet: Worksheet, appsNo: string): number {
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    if (cellText(sheet, r, fieldLabel('appsNo')) === appsNo) return r;
  }
  throw new Error(`No exported row for ${appsNo}`);
}

let mappingRequestId: string;
let autopayRequestId: string;
let secondImport: ValidationReport;

beforeAll(async () => {
  await truncateAll();

  admin = sessionOf(await makeUser({ role: 'admin', name: 'Import Admin' }));
  verifier = sessionOf(await makeUser({ role: 'verifier', smId: null, name: 'Vikram V' }));
  approver = sessionOf(await makeUser({ role: 'approver', smId: null, name: 'Anita A' }));
  tl = sessionOf(await makeUser({ role: 'tl', smId: null, tlCode: 'TL001', name: 'Team Lead One' }));
  acm = sessionOf(
    await makeUser({ role: 'acm', smId: null, acmCode: 'CCM01', name: 'Cluster One' }),
  );

  await importFixture();

  // A TL flipping AutoPay for their own rep — the plainest form of the report.
  autopayRequestId = await raiseAndApprove(tl, {
    category: 'AUTOPAY',
    appsNo: AUTOPAY_APPS,
    proposedValue: 'No',
    description: 'Mandate was never registered — bank confirmation attached.',
    files: [proof()],
  });

  // An ACM moving a sale between two of their teams. MAPPING is the category
  // that writes TWO columns (sm_id and sm_name), so it is the one where a
  // protected set derived from a single field name could leave half the change
  // exposed to the next import.
  mappingRequestId = await raiseAndApprove(acm, {
    category: 'MAPPING',
    direction: 'CLAIM_IN',
    appsNo: MAPPING_APPS,
    proposedValue: SM.SPLIT_CASE,
    description: 'Sale belongs to Ravi — lead was his.',
    files: [proof()],
  });

  ({ report: secondImport } = await importFixture());
});

afterAll(async () => {
  await Promise.all(written.map((path) => rm(path, { force: true })));
});

describe('the approval itself writes the record', () => {
  it('applies the AutoPay change a TL raised', async () => {
    const record = await recordFor(AUTOPAY_APPS);
    expect(record.autopay).toBe('No');
    expect(record.hasCorrections).toBe(true);

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, autopayRequestId));

    // Both halves of the annotation the export reads, and both halves of what
    // the re-import consults. `submitted_by` is the manager; the book is the
    // rep's.
    expect(request.status).toBe('APPROVED');
    expect(request.appliedAt).not.toBeNull();
    expect(request.fieldName).toBe('autopay');
    expect(request.submittedBy).toBe(tl.id);
    expect(request.smId).toBe(SM.SPLIT_CASE);
  });

  it('applies the reassignment an ACM raised, name and code together', async () => {
    const record = await recordFor(MAPPING_APPS);
    expect(record.smId).toBe(SM.SPLIT_CASE);
    // Resolved from the roster, never from the submitted text — spec 7.2.
    expect(record.smName).toBe('Ravi Kumar');

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, mappingRequestId));
    expect(request.status).toBe('APPROVED');
    expect(request.category).toBe('MAPPING');
    expect(request.fieldName).toBe('smId');
  });
});

describe('re-importing the stale workbook does not revert the manager corrections', () => {
  it('escalates both as conflicts on the review screen rather than deciding silently', () => {
    expect(secondImport.conflicts).toContainEqual(
      expect.objectContaining({
        appsNo: AUTOPAY_APPS,
        field: 'autopay',
        currentValue: 'No',
        incomingValue: 'Yes',
      }),
    );

    expect(secondImport.conflicts).toContainEqual(
      expect.objectContaining({ appsNo: MAPPING_APPS, field: 'smId', currentValue: SM.SPLIT_CASE }),
    );

    // No smName conflict on THIS row, and that is correct rather than a gap:
    // `loginRow` defaults SM_Name to "Ravi Kumar" and the REJECTED fixture row
    // overrides only SM_ID, so the sheet already agrees with the roster-resolved
    // name the approval wrote. A conflict is a DISAGREEMENT, and there is none.
    // The row below is the one where the names genuinely differ — see the
    // protected-set assertion in the next test for why smName is guarded anyway.
    expect(secondImport.conflicts).not.toContainEqual(
      expect.objectContaining({ appsNo: MAPPING_APPS, field: 'smName' }),
    );
  });

  it('guards smName alongside smId, so a file that DID rename the rep is held too', async () => {
    // The regression this whole suite exists for. Protection is derived through
    // `resolveTargetField` — the same function the approval used — so a MAPPING
    // correction guards both columns it wrote. Asserted on the protected set
    // directly, because whether a conflict fires also depends on what the sheet
    // happens to say, and the guarantee under test is that the column is held at
    // all. Holding sm_id while letting a file overwrite sm_name would leave the
    // record claiming one rep's code carries another rep's name.
    const snapshots = await loadMasterSnapshots([MAPPING_APPS, AUTOPAY_APPS]);

    expect(snapshots.get(MAPPING_APPS)?.protectedFields).toEqual(
      expect.arrayContaining(['smId', 'smName']),
    );
    expect(snapshots.get(AUTOPAY_APPS)?.protectedFields).toEqual(['autopay']);

    // And the case where the sheet does disagree on the name is escalated, both
    // columns at once — the fixture's mapping-changes row renames as well as
    // reassigns.
    expect(secondImport.conflicts).toContainEqual(
      expect.objectContaining({ field: 'smId', currentValue: 'C2CM88888' }),
    );
    expect(secondImport.conflicts).toContainEqual(
      expect.objectContaining({ field: 'smName', currentValue: 'Sunil Rao' }),
    );
  });

  it('keeps the approved AutoPay value even though the sheet still says Yes', async () => {
    const record = await recordFor(AUTOPAY_APPS);
    expect(record.autopay).toBe('No');
  });

  it('keeps the approved reassignment even though the sheet still credits the old rep', async () => {
    const record = await recordFor(MAPPING_APPS);
    expect(record.smId).toBe(SM.SPLIT_CASE);
    expect(record.smName).toBe('Ravi Kumar');
  });
});

/** Generates an export, remembers the file for cleanup, and hands back its master sheet. */
async function exportMaster(filters = NO_FILTERS): Promise<Worksheet> {
  const generated = await runExport(admin, filters);
  const [row] = await db.select().from(excelExport).where(eq(excelExport.id, generated.id));

  const absolute = resolveStoredPath(row.storedPath);
  written.push(absolute);

  const workbook = new Workbook();
  await workbook.xlsx.readFile(absolute);
  const master = workbook.getWorksheet(SHEET_MASTER);
  if (!master) throw new Error('The export has no master sheet');
  return master;
}

describe('the export carries what the manager changed', () => {
  it('exports the corrected values and annotates them', async () => {
    const master = await exportMaster();

    const autopayRow = rowNumberFor(master, AUTOPAY_APPS);
    expect(cellText(master, autopayRow, fieldLabel('autopay'))).toBe('No');
    expect(cellText(master, autopayRow, 'Corrected_Fields')).toContain(fieldLabel('autopay'));
    expect(cellText(master, autopayRow, 'Correction_Count')).toBe('1');

    const mappingRow = rowNumberFor(master, MAPPING_APPS);
    expect(cellText(master, mappingRow, fieldLabel('smId'))).toBe(SM.SPLIT_CASE);
    expect(cellText(master, mappingRow, fieldLabel('smName'))).toBe('Ravi Kumar');
    expect(cellText(master, mappingRow, 'Corrected_Fields')).toContain(fieldLabel('smId'));
    expect(cellText(master, mappingRow, 'Correction_Count')).toBe('1');
  });

  it('reaches the corrected row through the rep it was moved TO, not the one it came from', async () => {
    // The user's sentence: "it should reflect on the SM's application number."
    // An export scoped to the gaining rep must contain the moved application,
    // and one scoped to the losing rep must not.
    const gaining = await exportMaster({ ...NO_FILTERS, smId: SM.SPLIT_CASE });
    const losing = await exportMaster({ ...NO_FILTERS, smId: SM.PENDING_REP });

    expect(rowNumberFor(gaining, MAPPING_APPS)).toBeGreaterThan(1);
    expect(() => rowNumberFor(losing, MAPPING_APPS)).toThrow();
  });
});
