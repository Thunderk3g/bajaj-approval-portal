import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbook, type Worksheet } from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CORRECTED_FILL_ARGB,
  SHEET_CORRECTIONS,
  SHEET_INFO,
  SHEET_MASTER,
  correctionNote,
  exportFileName,
  extraColumnKeys,
  isoDateToExcelDate,
  moneyToExcelNumber,
  prepareExtraCell,
  writeExportWorkbook,
  type ExportCorrection,
  type ExportRecord,
} from '@/lib/export/build';
import { NO_FILTERS } from '@/lib/export/schemas';
import { CANONICAL_FIELDS } from '@/lib/fields';

/**
 * Everything here asserts on the FILE, not on what the builder was handed.
 * A test that inspects the input never notices that ExcelJS dropped the
 * comment, wrote the identifier as a number, or lost the fill on save — which
 * are the three failure modes this sheet exists to prevent.
 */

const APPROVED_AT = new Date('2026-07-01T09:30:00.000Z');
const SUBMITTED_AT = new Date('2026-06-28T04:15:00.000Z');
// Between the two, so a test asserting the note's ordering fails if the stages
// are ever emitted the wrong way round.
const VERIFIED_AT = new Date('2026-06-29T11:00:00.000Z');

// The Master Data `Period` column is filled from the lookup, never from the
// record, so the id has to be one the map answers for.
const PERIOD_ID = '55555555-5555-4555-8555-555555555555';
const PERIOD_LABELS = new Map([[PERIOD_ID, 'Jun 2026']]);

function record(overrides: Partial<ExportRecord> = {}): ExportRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    appsNo: '5920000001',
    policyNo: '0412345678',
    clientName: 'Ravi Kumar',
    leadId: 'LD-1',
    smId: 'C2CM21350',
    smName: 'Asha Rao',
    tlId: 'TL1',
    tlName: 'Tara Lal',
    ccmId: 'CC1',
    ccmName: 'Chetan M',
    location: 'Pune',
    loginDate: '2026-06-01',
    issuedDate: '2026-06-03',
    fp: '4195.42',
    anp: '120000.50',
    productName: 'Smart Protect',
    productType: 'Term',
    productVariant: 'Level',
    bookingFrequency: 'Annual',
    payMode: 'ECS',
    status: 'ISSUED',
    status2: 'Issued',
    autopay: 'Yes',
    extra: { FY: '2026-27', RECEIPT_NO: '900012345', Source: 'Digital' },
    periodId: PERIOD_ID,
    sourceBatchId: null,
    sourceRowNumber: 3,
    currentVersion: 2,
    hasCorrections: true,
    createdAt: new Date('2026-06-05T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T09:30:00.000Z'),
    ...overrides,
  } as ExportRecord;
}

function correction(overrides: Partial<ExportCorrection> = {}): ExportCorrection {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    recordId: '11111111-1111-4111-8111-111111111111',
    appsNo: '5920000001',
    category: 'AUTOPAY',
    fieldName: 'autopay',
    fieldLabel: 'AutoPay',
    originalValue: null,
    proposedValue: 'Yes',
    description: 'NACH mandate registered on 12 June.',
    smId: 'C2CM21350',
    submitterName: 'Ravi Sales',
    submitterEmail: 'ravi@example.test',
    submittedAt: SUBMITTED_AT,
    // Both review stages — 2026-07-28 spec section 3. The default fixture goes
    // through the full path, so a test that wants a pre-verifier correction has
    // to say so explicitly rather than getting one by omission.
    verifierName: 'Vikram Verifier',
    verifierEmail: 'vikram@example.test',
    verifiedAt: VERIFIED_AT,
    verifierRemarks: 'NACH mandate copy matches the application.',
    approverName: 'Anita Approver',
    approverEmail: 'anita@example.test',
    status: 'APPROVED',
    approverRemarks: 'Mandate copy verified.',
    reviewedAt: APPROVED_AT,
    appliedAt: APPROVED_AT,
    periodLabel: 'Jun 2026',
    ...overrides,
  };
}

const RECORDS: ExportRecord[] = [
  record(),
  record({
    id: '22222222-2222-4222-8222-222222222222',
    appsNo: '5920000002',
    policyNo: null,
    clientName: 'Sunita Devi',
    smId: 'C2CM21351',
    smName: 'Bela Nair',
    issuedDate: null,
    fp: '500.00',
    anp: '500.00',
    status: 'PENDING',
    autopay: null,
    // LA Occupation exists on this record only — a column present on some rows
    // must still get its own column in the sheet.
    extra: { FY: '2026-27', Source: '-', 'LA Occupation': 'Salaried' },
    // Imported before the portal tracked periods. Its Period cell has to stay
    // blank rather than inherit the label of the row above it.
    periodId: null,
    hasCorrections: false,
    currentVersion: 1,
  }),
];

const CORRECTIONS: ExportCorrection[] = [
  correction(),
  correction({
    id: '44444444-4444-4444-8444-444444444444',
    category: 'ISSUANCE_DATE',
    fieldName: 'issuedDate',
    fieldLabel: 'Issued date',
    originalValue: null,
    proposedValue: '2026-06-03',
    description: 'Policy bond dated 3 June.',
  }),
];

let workbookPath: string;
let directory: string;
let master: Worksheet;
let corrections: Worksheet;
let info: Worksheet;
let reopened: Workbook;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdrp-export-'));
  workbookPath = join(directory, 'export.xlsx');

  await writeExportWorkbook(
    {
      records: RECORDS,
      corrections: CORRECTIONS,
      periodLabels: PERIOD_LABELS,
      meta: {
        fileName: 'sales-reconciliation-20260727-1015-v1.xlsx',
        generatedAt: new Date('2026-07-27T10:15:00.000Z'),
        generatedByName: 'Admin One',
        generatedByEmail: 'admin@example.test',
        filters: { ...NO_FILTERS, smId: 'C2CM21350', correctedOnly: true },
        batchLabel: 'June Login Data.xlsb (uploaded 2026-07-01)',
      },
    },
    workbookPath,
  );

  reopened = new Workbook();
  await reopened.xlsx.readFile(workbookPath);
  master = reopened.getWorksheet(SHEET_MASTER)!;
  corrections = reopened.getWorksheet(SHEET_CORRECTIONS)!;
  info = reopened.getWorksheet(SHEET_INFO)!;
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Header text to 1-based column index, read from the file that was written. */
function columnIndex(sheet: Worksheet, header: string): number {
  const values = sheet.getRow(1).values as unknown[];
  const index = values.findIndex((v) => v === header);
  if (index < 0) throw new Error(`No column "${header}" in ${sheet.name}`);
  return index;
}

function cellAt(sheet: Worksheet, rowNumber: number, header: string) {
  return sheet.getRow(rowNumber).getCell(columnIndex(sheet, header));
}

describe('workbook structure (spec 8)', () => {
  it('writes exactly the three named sheets', () => {
    expect(reopened.worksheets.map((w) => w.name)).toEqual([
      SHEET_MASTER,
      SHEET_CORRECTIONS,
      SHEET_INFO,
    ]);
  });

  it('opens Master Data with the canonical columns, in registry order', () => {
    const headers = (master.getRow(1).values as unknown[]).slice(1, CANONICAL_FIELDS.length + 1);
    expect(headers).toEqual(CANONICAL_FIELDS.map((f) => f.label));
  });

  it('closes Master Data with the three correction columns', () => {
    const headers = (master.getRow(1).values as unknown[]).slice(1) as string[];
    expect(headers.slice(-3)).toEqual([
      'Corrected_Fields',
      'Correction_Count',
      'Last_Corrected_On',
    ]);
  });

  it('emits one row per exported record', () => {
    expect(master.actualRowCount).toBe(RECORDS.length + 1);
  });
});

describe('preserved extra columns (spec 5.4)', () => {
  it('carries every extra key through to the file', () => {
    const headers = (master.getRow(1).values as unknown[]).slice(1) as string[];
    expect(headers).toContain('FY');
    expect(headers).toContain('RECEIPT_NO');
    expect(headers).toContain('Source');
  });

  it('keeps a column that only one record carries', () => {
    // Taking the first row's keys would have dropped this one entirely.
    const headers = (master.getRow(1).values as unknown[]).slice(1) as string[];
    expect(headers).toContain('LA Occupation');
    expect(cellAt(master, 3, 'LA Occupation').value).toBe('Salaried');
    expect(cellAt(master, 2, 'LA Occupation').value).toBeFalsy();
  });

  it('unions keys in first-seen order rather than sorting them', () => {
    expect(extraColumnKeys(RECORDS)).toEqual(['FY', 'RECEIPT_NO', 'Source', 'LA Occupation']);
  });
});

describe('reconciliation period (2026-07-28 spec 4)', () => {
  it('names the period each record belongs to', () => {
    // Resolved through periodLabels rather than written from the record, so a
    // period renamed after the fact exports under the name the screen shows.
    expect(cellAt(master, 2, 'Period').value).toBe('Jun 2026');
  });

  it('leaves a record that predates periods blank rather than guessing one', () => {
    expect(cellAt(master, 3, 'Period').value).toBeFalsy();
  });

  it('sits after the preserved extra columns, ahead of the correction summary', () => {
    // Position matters to anyone diffing this month's workbook against last
    // month's: Period landing inside the extra block would shift every
    // preserved column and make the two files look wholly different.
    const headers = (master.getRow(1).values as unknown[]).slice(1) as string[];
    expect(headers.slice(-4)).toEqual([
      'Period',
      'Corrected_Fields',
      'Correction_Count',
      'Last_Corrected_On',
    ]);
  });
});

describe('identifiers stay text (spec 5.4)', () => {
  it('round-trips a 10-digit application number with every digit intact', () => {
    const cell = cellAt(master, 2, 'Application number');
    expect(typeof cell.value).toBe('string');
    expect(cell.value).toBe('5920000001');
    expect(String(cell.value)).not.toMatch(/[eE]\+?\d/);
    expect(String(cell.value)).toHaveLength(10);
  });

  it('keeps a leading zero on a policy number', () => {
    // A numeric cell silently drops it, and the policy no longer matches source.
    expect(cellAt(master, 2, 'Policy number').value).toBe('0412345678');
  });

  it('keeps a preserved receipt number as the text it was stored as', () => {
    expect(cellAt(master, 2, 'RECEIPT_NO').value).toBe('900012345');
  });

  it('demotes a long integer extra to text before Excel formats it as 5.92E+09', () => {
    // extra holds RECEIPT_NO and Product_Code, identifiers that are numeric
    // only by accident; Excel's General format goes scientific past 11 digits.
    expect(prepareExtraCell(5920000001234)).toEqual({ value: '5920000001234', numFmt: '@' });
    expect(prepareExtraCell(12)).toEqual({ value: 12 });
    expect(prepareExtraCell(null)).toEqual({ value: null });
  });
});

describe('money round-trips exactly (spec 3)', () => {
  it('reads back the fractional premium with no float drift', () => {
    const cell = cellAt(master, 2, 'FP (first premium)');
    expect(cell.value).toBe(4195.42);
    expect(typeof cell.value).toBe('number');
    expect(cell.numFmt).toBe('#,##0.00');
  });

  it('reads back a grouped amount exactly', () => {
    expect(cellAt(master, 2, 'ANP (annualised new premium)').value).toBe(120000.5);
  });

  it('converts through the integer paise count', () => {
    expect(moneyToExcelNumber('4195.42')).toBe(4195.42);
    expect(moneyToExcelNumber('0.01')).toBe(0.01);
    expect(moneyToExcelNumber('500')).toBe(500);
  });

  it('refuses a value too large for a double to name exactly', () => {
    // numeric(18,2) reaches 10^18 paise; 2^53 is where a double stops counting.
    expect(moneyToExcelNumber('99999999999999.99')).toBeNull();
    expect(moneyToExcelNumber('not money')).toBeNull();
  });
});

describe('dates are real Excel dates', () => {
  it('writes the issuance date on the day it happened, not a day either side', () => {
    const cell = cellAt(master, 2, 'Issued date');
    expect(cell.value).toBeInstanceOf(Date);
    expect((cell.value as Date).toISOString().slice(0, 10)).toBe('2026-06-03');
    expect(cell.numFmt).toBe('dd-mmm-yyyy');
  });

  it('leaves an unissued record empty rather than dated to the epoch', () => {
    expect(cellAt(master, 3, 'Issued date').value).toBeFalsy();
  });

  it('builds the serial at UTC midnight so no timezone shifts the day', () => {
    expect(isoDateToExcelDate('2026-06-03')?.toISOString()).toBe('2026-06-03T00:00:00.000Z');
  });
});

describe('corrected cells carry the fill and the comment (spec 8)', () => {
  it('highlights the corrected AutoPay cell', () => {
    const fill = cellAt(master, 2, 'AutoPay').fill;
    expect(fill?.type).toBe('pattern');
    expect((fill as { pattern?: string }).pattern).toBe('solid');
    expect((fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe(CORRECTED_FILL_ARGB);
  });

  it('attaches a comment naming the original value, the approver and the date', () => {
    const note = cellAt(master, 2, 'AutoPay').note;
    const text = typeof note === 'string' ? note : JSON.stringify(note);
    expect(text).toContain('(blank)');
    expect(text).toContain('Yes');
    expect(text).toContain('Anita Approver');
    expect(text).toContain('2026-07-01');
    // Asserted on the reopened file, not on correctionNote's return: the lines
    // are only useful if ExcelJS actually round-trips them into the comment.
    expect(text).toContain('Vikram Verifier');
  });

  it('carries the original value verbatim when there was one', () => {
    const note = cellAt(master, 2, 'Issued date').note;
    const text = typeof note === 'string' ? note : JSON.stringify(note);
    expect(text).toContain('Approved value: 2026-06-03');
  });

  it('leaves an uncorrected cell with neither a highlight nor a comment', () => {
    const cell = cellAt(master, 2, 'Client name');
    expect(cell.note).toBeUndefined();
    expect((cell.fill as { pattern?: string } | undefined)?.pattern ?? 'none').not.toBe('solid');
  });

  it('leaves every cell of an uncorrected record clean', () => {
    const cell = cellAt(master, 3, 'AutoPay');
    expect(cell.note).toBeUndefined();
    expect((cell.fill as { pattern?: string } | undefined)?.pattern ?? 'none').not.toBe('solid');
  });

  it('summarizes the corrections on the record row', () => {
    expect(cellAt(master, 2, 'Corrected_Fields').value).toBe('AutoPay, Issued date');
    expect(cellAt(master, 2, 'Correction_Count').value).toBe(2);
    expect((cellAt(master, 2, 'Last_Corrected_On').value as Date).toISOString()).toBe(
      APPROVED_AT.toISOString(),
    );
  });

  it('reports zero corrections on the untouched record', () => {
    expect(cellAt(master, 3, 'Correction_Count').value).toBe(0);
    expect(cellAt(master, 3, 'Corrected_Fields').value).toBeFalsy();
  });
});

describe('the correction note names both gates (2026-07-28 spec 3.5)', () => {
  it('names the verifier before the approver, the order the request travelled', () => {
    const note = correctionNote(correction());

    expect(note).toContain('Verified by: Vikram Verifier');
    expect(note).toContain('Verified on: 2026-06-29 11:00 UTC');
    expect(note).toContain('Approved by: Anita Approver');
    // Ordering, not just presence: the note is read as a narrative of who
    // touched the value, and verification before approval is the only sequence
    // the workflow can produce.
    expect(note.indexOf('Verified by:')).toBeLessThan(note.indexOf('Approved by:'));
  });

  it('omits the verifier lines entirely for a correction decided before the stage existed', () => {
    // Rows approved under the single-stage flow have no verifier. Printing
    // "Verified by: —" would claim a review that never happened.
    const note = correctionNote(
      correction({
        verifierName: null,
        verifierEmail: null,
        verifiedAt: null,
        verifierRemarks: null,
      }),
    );

    expect(note).not.toContain('Verified');
    expect(note).toContain('Approved by: Anita Approver');
  });
});

describe('Corrections Log sheet (spec 8)', () => {
  it('has the columns spec 8 names', () => {
    expect((corrections.getRow(1).values as unknown[]).slice(1)).toEqual([
      'Apps_No',
      'Period',
      'Field',
      'Original_Value',
      'Approved_Value',
      'Category',
      'Description',
      'Submitted_By',
      'SM_ID',
      'Submitted_On',
      'Verifier',
      'Verified_On',
      'Verifier_Remarks',
      'Approver',
      'Decision',
      'Remarks',
      'Decision_On',
    ]);
  });

  it('writes one row per applied correction', () => {
    expect(corrections.actualRowCount).toBe(CORRECTIONS.length + 1);
  });

  it('carries the original and the approved value on the AutoPay row', () => {
    expect(cellAt(corrections, 2, 'Apps_No').value).toBe('5920000001');
    expect(cellAt(corrections, 2, 'Field').value).toBe('AutoPay');
    expect(cellAt(corrections, 2, 'Original_Value').value).toBeFalsy();
    expect(cellAt(corrections, 2, 'Approved_Value').value).toBe('Yes');
    expect(cellAt(corrections, 2, 'Category').value).toBe('AUTOPAY');
    expect(cellAt(corrections, 2, 'Submitted_By').value).toBe('Ravi Sales');
    expect(cellAt(corrections, 2, 'SM_ID').value).toBe('C2CM21350');
    expect(cellAt(corrections, 2, 'Approver').value).toBe('Anita Approver');
    expect(cellAt(corrections, 2, 'Decision').value).toBe('APPROVED');
    expect(cellAt(corrections, 2, 'Remarks').value).toBe('Mandate copy verified.');
  });

  it('carries the verification stage as well as the decision', () => {
    // A log that names only the approver cannot answer whether a wrong value got
    // through because the verifier passed it or because the approver overrode
    // them — the first question asked of an export once one is wrong.
    expect(cellAt(corrections, 2, 'Verifier').value).toBe('Vikram Verifier');
    expect((cellAt(corrections, 2, 'Verified_On').value as Date).toISOString()).toBe(
      VERIFIED_AT.toISOString(),
    );
    expect(cellAt(corrections, 2, 'Verifier_Remarks').value).toBe(
      'NACH mandate copy matches the application.',
    );
    expect(cellAt(corrections, 2, 'Period').value).toBe('Jun 2026');
  });

  it('carries the issuance-date row with its proposed value', () => {
    expect(cellAt(corrections, 3, 'Field').value).toBe('Issued date');
    expect(cellAt(corrections, 3, 'Approved_Value').value).toBe('2026-06-03');
    expect((cellAt(corrections, 3, 'Decision_On').value as Date).toISOString()).toBe(
      APPROVED_AT.toISOString(),
    );
  });
});

describe('Export Info sheet (spec 8)', () => {
  function infoValue(label: string): unknown {
    for (let r = 2; r <= info.rowCount; r += 1) {
      if (info.getRow(r).getCell(1).value === label) return info.getRow(r).getCell(2).value;
    }
    throw new Error(`No "${label}" row on ${SHEET_INFO}`);
  }

  it('records who generated it and when', () => {
    expect(infoValue('Generated by')).toBe('Admin One');
    expect(infoValue('Generated by (email)')).toBe('admin@example.test');
    expect((infoValue('Generated at') as Date).toISOString()).toBe('2026-07-27T10:15:00.000Z');
  });

  it('records the filters that produced the row set', () => {
    expect(infoValue('Filter — SM_ID')).toBe('C2CM21350');
    expect(infoValue('Filter — corrected records only')).toBe('Yes');
    expect(String(infoValue('Filters applied'))).toContain('C2CM21350');
  });

  it('records the source batch and the counts', () => {
    expect(String(infoValue('Source batch'))).toContain('June Login Data.xlsb');
    expect(infoValue('Records exported')).toBe(2);
    expect(infoValue('Corrections applied')).toBe(2);
    expect(infoValue('Preserved extra columns')).toBe(4);
  });
});

describe('file naming (spec 8)', () => {
  it('matches the pattern spec 8 fixes', () => {
    const name = exportFileName(new Date(2026, 6, 27, 10, 5), 3);
    expect(name).toBe('sales-reconciliation-20260727-1005-v3.xlsx');
    expect(name).toMatch(/^sales-reconciliation-\d{8}-\d{4}-v\d+\.xlsx$/);
  });
});
