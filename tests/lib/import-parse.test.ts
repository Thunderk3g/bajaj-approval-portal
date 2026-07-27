import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildColumns, listSheets, readManpower, readMappingChanges, readSheet, suggestSheet } from '@/lib/import/parse';
import { suggestMapping, validateMapping } from '@/lib/import/mapping';
import { checkAnpFpRatio, extraFromRaw, validateRows } from '@/lib/import/validate';
import type { MasterRecordSnapshot } from '@/lib/import/types';
import { APPS, fixtureBuffer, ROW, SM, writeFixtures } from '../fixtures/workbook';

/**
 * Parser, mapper and validator, run against BOTH fixture formats.
 *
 * The `.xlsb` half is not ceremony: the real source workbook is Excel Binary,
 * ExcelJS cannot read it at all, and a suite that only exercised `.xlsx` would
 * pass completely while the production import failed on the first upload.
 */

const FORMATS = ['xlsx', 'xlsb'] as const;

function loginSheet(format: (typeof FORMATS)[number]) {
  return readSheet(fixtureBuffer(format), { sheetName: 'Login Data' });
}

function validatedLoginRows(
  format: (typeof FORMATS)[number],
  existing?: Map<string, MasterRecordSnapshot>,
) {
  const sheet = loginSheet(format);
  const { mapping } = suggestMapping(sheet.columns);
  return {
    sheet,
    mapping,
    outcome: validateRows(sheet.rows, { columns: sheet.columns, mapping, existing }),
  };
}

describe.each(FORMATS)('sheet listing (%s) — spec 6.1', (format) => {
  it('reports every sheet with its dimensions without parsing them', () => {
    const sheets = listSheets(fixtureBuffer(format));
    expect(sheets.map((s) => s.name)).toEqual([
      'Login Data',
      'Manpower',
      'Mapping Changes Latest',
      'SM Summary',
      'Lead Dump',
    ]);

    const login = sheets.find((s) => s.name === 'Login Data')!;
    expect(login.rowCount).toBe(12); // header + 11 data rows
    expect(login.columnCount).toBe(24);
  });

  it('offers the transaction sheet first', () => {
    expect(suggestSheet(listSheets(fixtureBuffer(format)))).toBe('Login Data');
  });
});

describe.each(FORMATS)('raw cell reading (%s) — spec 6.3', (format) => {
  it('delivers Apps_No as a number, so all ten digits survive', () => {
    // Routed through SheetJS's formatted text this cell reads "5.92E+09" and the
    // identifier is destroyed before normalization ever sees it.
    const sheet = loginSheet(format);
    const first = sheet.rows[0];
    expect(typeof first.cells.Apps_No).toBe('number');
    expect(first.cells.Apps_No).toBe(5920000001);
  });

  it('never renders an application number in scientific notation', () => {
    const { outcome } = validatedLoginRows(format);
    for (const row of outcome.rows) {
      const appsNo = row.normalized.appsNo;
      if (appsNo === null) continue;
      expect(appsNo).not.toMatch(/[eE]/);
      expect(appsNo).toMatch(/^\d{10}$/);
    }
    expect(outcome.rows[0].normalized.appsNo).toBe(APPS.ISSUED_COMPLETE);
  });

  it('reads dates as Excel serials, not as text', () => {
    const sheet = loginSheet(format);
    expect(sheet.rows[0].cells.Issued_Date).toBe(46176);
    const { outcome } = validatedLoginRows(format);
    expect(outcome.rows[0].normalized.issuedDate).toBe('2026-06-03');
  });

  it('reports worksheet row numbers, so a problem can be found in Excel', () => {
    const sheet = loginSheet(format);
    expect(sheet.rows[0].rowNumber).toBe(ROW.ISSUED_COMPLETE);
    expect(sheet.rows.at(-1)!.rowNumber).toBe(ROW.ISSUED_ANNUAL);
  });
});

describe.each(FORMATS)('configurable header row (%s) — spec 6.1', (format) => {
  it('reads SM Summary, whose headers are on row 2 under a totals row', () => {
    const wrong = readSheet(fixtureBuffer(format), { sheetName: 'SM Summary' });
    expect(wrong.columns[0].key).toBe('TOTAL');

    const right = readSheet(fixtureBuffer(format), { sheetName: 'SM Summary', headerRow: 2 });
    expect(right.columns.map((c) => c.key)).toEqual([
      'SM_ID',
      'Rows',
      'ANP',
      'Issued',
      'Pending',
      'Rejected',
    ]);
    expect(right.rows[0].rowNumber).toBe(3);
    expect(right.rows[0].cells.SM_ID).toBe(SM.SPLIT_CASE);
  });
});

describe.each(FORMATS)('malformed header rows (%s) — spec 6.1', (format) => {
  it('names a blank header and disambiguates the duplicate Location columns', () => {
    const sheet = readSheet(fixtureBuffer(format), { sheetName: 'Lead Dump' });

    expect(sheet.columns.map((c) => c.key)).toEqual([
      'Lead_ID',
      '(column 2)',
      'Location (1)',
      'Location (2)',
      'Notes',
    ]);

    // Neither Location silently collides with the other.
    expect(sheet.rows[0].cells['Location (1)']).toBe('Pune');
    expect(sheet.rows[0].cells['Location (2)']).toBe('Maharashtra');
    expect(sheet.rows[0].cells['(column 2)']).toBe('orphan value');
  });
});

describe('header edge cases handled without a workbook', () => {
  it('drops trailing untitled columns rather than synthesising thousands of them', () => {
    // Lead Dump declares 16,383 columns of empty formatting. A "(column N)" for
    // each would bury the mapping screen under columns that hold nothing.
    expect(buildColumns(['A', 'B', '', '', null]).map((c) => c.key)).toEqual(['A', 'B']);
  });

  it('returns nothing for a wholly empty header row', () => {
    expect(buildColumns(['', null, undefined])).toEqual([]);
  });
});

describe.each(FORMATS)('mapping auto-suggestion (%s) — spec 6.2', (format) => {
  it('resolves the renamed columns without the admin knowing about the rename', () => {
    const { mapping } = suggestMapping(loginSheet(format).columns);
    expect(mapping.anp).toBe('ANP'); // the requirement called this APE
    expect(mapping.fp).toBe('FP'); // the requirement called this FRP
    expect(mapping.issuedDate).toBe('Issued_Date'); // requirement said Issuance_Date
    expect(mapping.appsNo).toBe('Apps_No');
    expect(mapping.smId).toBe('SM_ID');
    expect(mapping.status2).toBe('Status 2');
    expect(mapping.autopay).toBe('AutoPay');
  });

  it('leaves columns with no canonical home unmapped rather than forcing them', () => {
    const suggestion = suggestMapping(loginSheet(format).columns);
    expect(suggestion.unmappedColumns).toEqual(expect.arrayContaining(['FY', 'Source']));
  });

  it('never maps two fields to the same column', () => {
    const suggestion = suggestMapping(loginSheet(format).columns);
    const used = Object.values(suggestion.mapping);
    expect(new Set(used).size).toBe(used.length);
  });

  it('gives one of the duplicate Location columns to the field and leaves the other for extra', () => {
    const sheet = readSheet(fixtureBuffer(format), { sheetName: 'Lead Dump' });
    const suggestion = suggestMapping(sheet.columns);
    expect(suggestion.mapping.location).toBe('Location (1)');
    expect(suggestion.unmappedColumns).toContain('Location (2)');
  });
});

describe('mapping validation', () => {
  const columns = [
    { index: 0, header: 'Apps_No', key: 'Apps_No', blank: false, duplicate: false },
    { index: 1, header: 'SM_ID', key: 'SM_ID', blank: false, duplicate: false },
  ];

  it('refuses a mapping missing a required field', () => {
    const problems = validateMapping({ appsNo: 'Apps_No' }, columns);
    expect(problems.map((p) => p.code)).toContain('REQUIRED_UNMAPPED');
  });

  it('refuses two fields pointing at one column', () => {
    const problems = validateMapping({ appsNo: 'Apps_No', policyNo: 'Apps_No', smId: 'SM_ID' }, columns);
    expect(problems.map((p) => p.code)).toContain('COLUMN_REUSED');
  });

  it('refuses a column that is not in the sheet', () => {
    const problems = validateMapping({ appsNo: 'Apps_No', smId: 'SM_ID', fp: 'Nope' }, columns);
    expect(problems.map((p) => p.code)).toContain('UNKNOWN_COLUMN');
  });

  it('accepts a complete mapping', () => {
    expect(validateMapping({ appsNo: 'Apps_No', smId: 'SM_ID' }, columns)).toEqual([]);
  });
});

describe.each(FORMATS)('status-conditional gap detection (%s) — spec 6.4', (format) => {
  it('counts blanks only on ISSUED rows', () => {
    const { outcome } = validatedLoginRows(format);
    const byRow = new Map(outcome.rows.map((r) => [r.rowNumber, r]));

    // ISSUED with a "-" policy number and a "-" AutoPay: two genuine gaps.
    expect(byRow.get(ROW.ISSUED_MISSING_POLICY_AND_AUTOPAY)!.gaps.sort()).toEqual([
      'MISSING_AUTOPAY',
      'MISSING_POLICY_NO',
    ]);

    // PENDING with every one of those fields blank: zero gaps. This is the rule
    // that stops 105 false issuance-date tasks and 105 false policy-number ones
    // burying the real work.
    expect(byRow.get(ROW.PENDING_BLANKS)!.gaps).toEqual([]);

    // REJECTED with no AutoPay: also zero. AutoPay on a rejected application is
    // not actionable.
    expect(byRow.get(ROW.REJECTED_NO_AUTOPAY)!.gaps).toEqual([]);

    expect(byRow.get(ROW.ISSUED_MISSING_ISSUED_DATE)!.gaps).toEqual(['MISSING_ISSUED_DATE']);
    expect(byRow.get(ROW.ISSUED_COMPLETE)!.gaps).toEqual([]);
  });

  it('counts gaps per rep, and only for rows that will actually commit', () => {
    const { outcome } = validatedLoginRows(format);
    expect(Object.fromEntries(outcome.gapsBySmId)).toEqual({
      [SM.SPLIT_CASE]: 1,
      [SM.GAP_REP]: 1,
    });
  });
});

describe.each(FORMATS)('severity classification (%s) — spec 6.5', (format) => {
  it('blocks a row with no Apps_No and a row with no SM_ID', () => {
    const { outcome } = validatedLoginRows(format);
    const byRow = new Map(outcome.rows.map((r) => [r.rowNumber, r]));

    const noSm = byRow.get(ROW.MISSING_SM_ID)!;
    expect(noSm.status).toBe('INVALID');
    expect(noSm.issues.some((i) => i.field === 'smId' && i.code === 'REQUIRED_MISSING')).toBe(true);

    const noApps = byRow.get(ROW.MISSING_APPS_NO)!;
    expect(noApps.status).toBe('INVALID');
    expect(noApps.issues.some((i) => i.field === 'appsNo' && i.severity === 'ERROR')).toBe(true);
  });

  it('blocks a negative premium', () => {
    const { outcome } = validatedLoginRows(format);
    const row = outcome.rows.find((r) => r.rowNumber === ROW.NEGATIVE_PREMIUM)!;
    expect(row.status).toBe('INVALID');
    expect(row.issues.some((i) => i.code === 'MONEY_NEGATIVE')).toBe(true);
  });

  it('warns, and still commits, when ANP contradicts the booking frequency', () => {
    // Spec 13.2 note 8: ANP = FP x 12 Monthly, x 1 Annual. Worth surfacing,
    // never worth refusing a real premium over.
    const { outcome } = validatedLoginRows(format);
    const row = outcome.rows.find((r) => r.rowNumber === ROW.ANP_RATIO_MISMATCH)!;
    expect(row.status).toBe('VALID');
    const issue = row.issues.find((i) => i.code === 'ANP_FP_RATIO_MISMATCH')!;
    expect(issue.severity).toBe('WARNING');
  });

  it('does not warn when the ratio agrees, in either frequency', () => {
    const { outcome } = validatedLoginRows(format);
    for (const rowNumber of [ROW.ISSUED_COMPLETE, ROW.ISSUED_ANNUAL]) {
      const row = outcome.rows.find((r) => r.rowNumber === rowNumber)!;
      expect(row.issues.some((i) => i.code === 'ANP_FP_RATIO_MISMATCH')).toBe(false);
    }
  });

  it('lists every row that will be skipped, with its row number', () => {
    const { outcome } = validatedLoginRows(format);
    const skipped = outcome.rows.filter((r) => r.status !== 'VALID').map((r) => r.rowNumber).sort((a, b) => a - b);
    expect(skipped).toEqual([
      ROW.DUPLICATE_OF_ROW_2,
      ROW.MISSING_SM_ID,
      ROW.MISSING_APPS_NO,
      ROW.NEGATIVE_PREMIUM,
    ]);
  });
});

describe('ANP/FP ratio arithmetic', () => {
  it('compares in integer paise rather than through a float', () => {
    // 4195.42 * 12 is 50345.039999999994 in binary floating point.
    expect(
      checkAnpFpRatio({ fp: '4195.42', anp: '50345.04', bookingFrequency: 'Monthly' }),
    ).toEqual([]);
  });

  it('skips the check when the frequency is not one it knows', () => {
    expect(checkAnpFpRatio({ fp: '1000.00', anp: '1000.00', bookingFrequency: 'Fortnightly' })).toEqual([]);
  });

  it('skips the check when either amount is absent', () => {
    expect(checkAnpFpRatio({ fp: null, anp: '1000.00', bookingFrequency: 'Monthly' })).toEqual([]);
  });
});

describe.each(FORMATS)('duplicate Apps_No (%s) — spec 6.6', (format) => {
  it('flags the later occurrence and points at the first, which stays authoritative', () => {
    const { outcome } = validatedLoginRows(format);
    const first = outcome.rows.find((r) => r.rowNumber === ROW.ISSUED_COMPLETE)!;
    const later = outcome.rows.find((r) => r.rowNumber === ROW.DUPLICATE_OF_ROW_2)!;

    expect(first.isDuplicate).toBe(false);
    expect(first.status).toBe('VALID');

    expect(later.isDuplicate).toBe(true);
    expect(later.duplicateOfRow).toBe(ROW.ISSUED_COMPLETE);
    expect(later.status).toBe('DUPLICATE');
    expect(later.issues.some((i) => i.code === 'DUPLICATE_IN_BATCH')).toBe(true);
  });

  it('detects an Apps_No that already exists in the master table', () => {
    const existing = new Map<string, MasterRecordSnapshot>([
      [
        APPS.ISSUED_COMPLETE,
        {
          id: 'record-1',
          appsNo: APPS.ISSUED_COMPLETE,
          values: { autopay: 'Yes', appsNo: APPS.ISSUED_COMPLETE },
          protectedFields: [],
        },
      ],
    ]);

    const { outcome } = validatedLoginRows(format, existing);
    const row = outcome.rows.find((r) => r.rowNumber === ROW.ISSUED_COMPLETE)!;

    expect(row.updatesExisting).toBe(true);
    expect(row.issues.some((i) => i.code === 'DUPLICATE_OF_EXISTING')).toBe(true);
    // It updates rather than being refused: section 6.8 inserts new Apps_No and
    // updates existing ones. It is not an error.
    expect(row.status).toBe('VALID');
  });
});

describe.each(FORMATS)('re-import conflict policy (%s) — spec 6.8', (format) => {
  const protectedSnapshot = new Map<string, MasterRecordSnapshot>([
    [
      APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY,
      {
        id: 'record-2',
        appsNo: APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY,
        values: {
          appsNo: APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY,
          // An approved correction moved the issuance date. The file still says
          // 2026-06-03, and it must not win.
          issuedDate: '2026-06-30',
          autopay: 'Yes',
        },
        protectedFields: ['issuedDate'],
      },
    ],
  ]);

  it('records a conflict instead of overwriting an approved correction', () => {
    const { outcome } = validatedLoginRows(format, protectedSnapshot);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]).toMatchObject({
      rowNumber: ROW.ISSUED_MISSING_POLICY_AND_AUTOPAY,
      appsNo: APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY,
      field: 'issuedDate',
      currentValue: '2026-06-30',
      incomingValue: '2026-06-03',
    });
  });

  it('reports the conflict as a warning on the row, not as a failure', () => {
    const { outcome } = validatedLoginRows(format, protectedSnapshot);
    const row = outcome.rows.find((r) => r.rowNumber === ROW.ISSUED_MISSING_POLICY_AND_AUTOPAY)!;
    const issue = row.issues.find((i) => i.code === 'APPROVED_CORRECTION_CONFLICT')!;
    expect(issue.severity).toBe('WARNING');
    expect(row.status).toBe('VALID');
  });

  it('raises no conflict when the file agrees with the approved value', () => {
    const agreeing = new Map<string, MasterRecordSnapshot>([
      [
        APPS.ISSUED_COMPLETE,
        {
          id: 'record-1',
          appsNo: APPS.ISSUED_COMPLETE,
          values: { appsNo: APPS.ISSUED_COMPLETE, autopay: 'Yes' },
          protectedFields: ['autopay'],
        },
      ],
    ]);

    const { outcome } = validatedLoginRows(format, agreeing);
    expect(outcome.conflicts).toEqual([]);
  });
});

describe.each(FORMATS)('unmapped columns are preserved (%s) — spec 5.4', (format) => {
  it('keeps a column the mapping did not claim', () => {
    const { outcome } = validatedLoginRows(format);
    expect(outcome.rows[0].extra.FY).toBe('FY26');
  });

  it('drops the sentinel rather than storing a literal hyphen', () => {
    const { outcome } = validatedLoginRows(format);
    expect(outcome.rows[0].extra.Source).toBeUndefined();
  });

  it('claims nothing when a column is mapped', () => {
    expect(extraFromRaw({ Apps_No: 1, FY: 'FY26' }, { appsNo: 'Apps_No' })).toEqual({ FY: 'FY26' });
  });
});

describe.each(FORMATS)('secondary sheets (%s) — spec 6.7, 13.1', (format) => {
  it('reads App Number to SM ID pairs', () => {
    const pairs = readMappingChanges(fixtureBuffer(format));
    expect(pairs).toHaveLength(2);
    expect(pairs[0].appsNo).toBe(Number(APPS.MAPPING_ONLY));
    expect(pairs[0].smId).toBe(SM.GAP_REP);
  });

  it('reads the rep roster', () => {
    const roster = readManpower(fixtureBuffer(format));
    expect(roster).toHaveLength(4);
    expect(roster[0].smId).toBe(SM.SPLIT_CASE);
    expect(roster[0].smName).toBe('Ravi Kumar');
    // 512454 appears in Login Data but not here — it must become an orphan.
    expect(roster.map((r) => r.smId)).not.toContain(SM.ORPHAN_NUMERIC);
  });
});

describe('SM_ID case collapsing across the batch — spec 6.3', () => {
  it('treats c2cm21350 and C2CM21350 as one rep', () => {
    const { outcome } = validatedLoginRows('xlsb');
    const lower = outcome.rows.find((r) => r.rowNumber === ROW.ISSUED_COMPLETE)!;
    const upper = outcome.rows.find((r) => r.rowNumber === ROW.ISSUED_MISSING_POLICY_AND_AUTOPAY)!;
    expect(lower.normalized.smId).toBe(SM.SPLIT_CASE);
    expect(upper.normalized.smId).toBe(SM.SPLIT_CASE);
  });
});

describe('the two formats agree', () => {
  it('produces identical normalized rows from .xlsx and .xlsb', () => {
    const fromXlsx = validatedLoginRows('xlsx').outcome.rows.map((r) => r.normalized);
    const fromXlsb = validatedLoginRows('xlsb').outcome.rows.map((r) => r.normalized);
    expect(fromXlsb).toEqual(fromXlsx);
  });
});

describe('fixtures on disk', () => {
  let paths: { xlsx: string; xlsb: string };

  beforeAll(async () => {
    paths = await writeFixtures();
  });

  it.each(['xlsx', 'xlsb'] as const)('reads a %s written to and read back from disk', async (format) => {
    // The in-memory buffer and a file that has been through the filesystem are
    // not the same test: the real import always arrives as bytes off disk.
    const sheet = readSheet(await readFile(paths[format]), { sheetName: 'Login Data' });
    expect(sheet.rows).toHaveLength(11);
    expect(sheet.rows[0].cells.Apps_No).toBe(5920000001);
  });
});
