import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

/**
 * The parser fixture, built with SheetJS at test time.
 *
 * The real `Businesses Dashboard Jun'26.xlsb` is 9.14 MB of production customer
 * data and is not in the repository, so the fixture is generated instead of
 * committed. It is written in BOTH `.xlsx` and `.xlsb`, and every parser test
 * runs against both: `.xlsb` is the format the real source actually uses, and a
 * reader that silently only works on `.xlsx` would pass a test suite built on
 * the convenient format and then fail on the real one.
 *
 * Every awkward property of the source is reproduced deliberately:
 *
 *   - `-` sentinels rather than empty cells (86% of Source, 29% of AutoPay)
 *   - the same rep spelled `c2cm21350` and `C2CM21350` (six such pairs exist)
 *   - Excel serial dates, not formatted text (46176 -> 2026-06-03)
 *   - all three Status values, so the section 6.4 gap table can be asserted
 *   - a 10-digit numeric Apps_No, which renders as 5.92E+09 through display text
 *   - `SM Summary` with totals on row 1 and headers on row 2
 *   - `Lead Dump` with a blank header and two columns both titled `Location`
 *   - a purely numeric SM_ID (512454) absent from the roster
 */

export const FIXTURE_DIR = join(process.cwd(), 'tests', 'fixtures', 'generated');

/** Serial 46176 is 2026-06-03; 46211 is 2026-07-08 — the observed range. */
const SERIAL_LOGIN = 46170;
const SERIAL_ISSUED = 46176;

export const LOGIN_DATA_HEADERS = [
  'Apps_No',
  'Policy_No',
  'Client_Name',
  'Lead_ID',
  'SM_ID',
  'SM_Name',
  'TL_ID',
  'TL_Name',
  'CCM_ID',
  'CCM_Name',
  'Location',
  'Login_Date',
  'Issued_Date',
  'FP',
  'ANP',
  'Product_Name',
  'Product_Type',
  'Booking_Frequency',
  'Pay_Mode',
  'Status',
  'Status 2',
  'AutoPay',
  'FY',
  'Source',
] as const;

type Row = (string | number | null)[];

/**
 * Worksheet row numbers are 1-based and the header is row 1, so the first data
 * row is row 2. The tests refer to these constants rather than to literals, so
 * inserting a row does not silently invalidate an assertion.
 */
export const ROW = {
  ISSUED_COMPLETE: 2,
  ISSUED_MISSING_POLICY_AND_AUTOPAY: 3,
  PENDING_BLANKS: 4,
  REJECTED_NO_AUTOPAY: 5,
  ISSUED_MISSING_ISSUED_DATE: 6,
  DUPLICATE_OF_ROW_2: 7,
  MISSING_SM_ID: 8,
  MISSING_APPS_NO: 9,
  ANP_RATIO_MISMATCH: 10,
  NEGATIVE_PREMIUM: 11,
  ISSUED_ANNUAL: 12,
} as const;

export const APPS = {
  ISSUED_COMPLETE: '5920000001',
  ISSUED_MISSING_POLICY_AND_AUTOPAY: '5920000002',
  PENDING_BLANKS: '5920000003',
  REJECTED: '5920000004',
  ISSUED_MISSING_ISSUED_DATE: '5920000005',
  NO_SM_ID: '5920000006',
  ANP_RATIO_MISMATCH: '5920000007',
  NEGATIVE_PREMIUM: '5920000008',
  ISSUED_ANNUAL: '5920000009',
  /** Prior-month application from `Mapping Changes Latest`, never in Login Data. */
  MAPPING_ONLY: '6160000001',
} as const;

export const SM = {
  /** Appears lowercase on one row and uppercase on another — the same person. */
  SPLIT_CASE: 'C2CM21350',
  PENDING_REP: 'C2CM99999',
  GAP_REP: 'C2CM88888',
  NEGATIVE_REP: 'C2CM77777',
  /** In Login Data but not in Manpower — spec section 13.2 note 7. */
  ORPHAN_NUMERIC: '512454',
} as const;

function loginRow(overrides: Partial<Record<(typeof LOGIN_DATA_HEADERS)[number], string | number>>): Row {
  const base: Record<string, string | number> = {
    Apps_No: 0,
    Policy_No: '-',
    Client_Name: 'Test Client',
    Lead_ID: 'LD-0001',
    SM_ID: SM.SPLIT_CASE,
    SM_Name: 'Ravi Kumar',
    TL_ID: 'TL001',
    TL_Name: 'Team Lead One',
    CCM_ID: 'CCM01',
    CCM_Name: 'Cluster One',
    Location: 'Pune',
    Login_Date: SERIAL_LOGIN,
    Issued_Date: SERIAL_ISSUED,
    FP: 4195.42,
    ANP: 50345.04,
    Product_Name: 'Smart Protect',
    Product_Type: 'Term',
    Booking_Frequency: 'Monthly',
    Pay_Mode: 'ECS',
    Status: 'ISSUED',
    'Status 2': 'FR-AR',
    AutoPay: 'Y',
    FY: 'FY26',
    Source: '-',
  };

  const merged = { ...base, ...overrides };
  return LOGIN_DATA_HEADERS.map((header) => merged[header] ?? null);
}

function loginData(): Row[] {
  return [
    [...LOGIN_DATA_HEADERS],

    // Complete ISSUED row. SM_ID deliberately lowercase.
    loginRow({
      Apps_No: Number(APPS.ISSUED_COMPLETE),
      Policy_No: 8810000001,
      SM_ID: 'c2cm21350',
    }),

    // ISSUED with the sentinel in Policy_No and AutoPay: two genuine gaps, and
    // the missing policy number makes it one of the true anomalies of 6.4.
    loginRow({
      Apps_No: Number(APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY),
      Policy_No: '-',
      AutoPay: '-',
    }),

    // PENDING with every conditional field blank. Zero gaps: an unissued policy
    // has no issuance date, and counting these is the 105-false-task mistake.
    loginRow({
      Apps_No: Number(APPS.PENDING_BLANKS),
      Policy_No: '-',
      Issued_Date: '-',
      AutoPay: '',
      Status: 'PENDING',
      'Status 2': 'PSTPNE6',
      SM_ID: SM.PENDING_REP,
      FP: 1000,
      ANP: 12000,
    }),

    loginRow({
      Apps_No: Number(APPS.REJECTED),
      Policy_No: 8810000004,
      AutoPay: '-',
      Status: 'REJECTED',
      'Status 2': 'DECLINED',
      SM_ID: SM.PENDING_REP,
      FP: 1000,
      ANP: 12000,
    }),

    loginRow({
      Apps_No: Number(APPS.ISSUED_MISSING_ISSUED_DATE),
      Policy_No: 8810000005,
      Issued_Date: '-',
      SM_ID: SM.GAP_REP,
      FP: 1000,
      ANP: 12000,
    }),

    // Same Apps_No as row 2 — the cross-month re-upload case of section 6.6.
    loginRow({
      Apps_No: Number(APPS.ISSUED_COMPLETE),
      Policy_No: 8810000001,
      SM_ID: SM.SPLIT_CASE,
    }),

    loginRow({ Apps_No: Number(APPS.NO_SM_ID), Policy_No: 8810000006, SM_ID: '-' }),

    loginRow({ Apps_No: '-', Policy_No: 8810000007 }),

    // Monthly booking but ANP == FP: contradicts ANP = FP x 12. A warning only.
    loginRow({
      Apps_No: Number(APPS.ANP_RATIO_MISMATCH),
      Policy_No: 8810000008,
      SM_ID: SM.ORPHAN_NUMERIC,
      FP: 1000,
      ANP: 1000,
      Booking_Frequency: 'Monthly',
    }),

    loginRow({
      Apps_No: Number(APPS.NEGATIVE_PREMIUM),
      Policy_No: 8810000009,
      SM_ID: SM.NEGATIVE_REP,
      FP: -100,
      ANP: -100,
    }),

    loginRow({
      Apps_No: Number(APPS.ISSUED_ANNUAL),
      Policy_No: 8810000010,
      SM_ID: SM.GAP_REP,
      FP: 4195.42,
      ANP: 4195.42,
      Booking_Frequency: 'Annual',
    }),
  ];
}

function manpowerSheet(): Row[] {
  return [
    ['SM_ID', 'SM_Name', 'TL_ID', 'TL_Name', 'CCM_ID', 'CCM_Name', 'Location'],
    [SM.SPLIT_CASE, 'Ravi Kumar', 'TL001', 'Team Lead One', 'CCM01', 'Cluster One', 'Pune'],
    [SM.PENDING_REP, 'Anita Desai', 'TL002', 'Team Lead Two', 'CCM01', 'Cluster One', 'Mumbai'],
    [SM.GAP_REP, 'Sunil Rao', 'TL002', 'Team Lead Two', 'CCM02', 'Cluster Two', 'Nagpur'],
    [SM.NEGATIVE_REP, 'Meera Joshi', 'TL003', 'Team Lead Three', 'CCM02', 'Cluster Two', 'Nashik'],
    // 512454 is deliberately absent: it must be flagged as an orphan, not dropped.
  ];
}

function mappingChangesSheet(): Row[] {
  return [
    ['App Number', 'SM ID'],
    // A prior-month application this database has never seen: counted, skipped.
    [Number(APPS.MAPPING_ONLY), SM.GAP_REP],
    // A reassignment of a row that IS in Login Data, to prove provenance is kept.
    [Number(APPS.ISSUED_MISSING_POLICY_AND_AUTOPAY), SM.GAP_REP],
  ];
}

/** Totals on row 1, headers on row 2 — exactly like the real `SM Summary`. */
function smSummarySheet(): Row[] {
  return [
    ['TOTAL', 1171, 4500000, null, null, null],
    ['SM_ID', 'Rows', 'ANP', 'Issued', 'Pending', 'Rejected'],
    [SM.SPLIT_CASE, 3, 150000, 2, 0, 1],
    [SM.GAP_REP, 2, 50000, 2, 0, 0],
  ];
}

/** A blank header and two columns both titled `Location` — the real `Lead Dump`. */
function leadDumpSheet(): Row[] {
  return [
    ['Lead_ID', '', 'Location', 'Location', 'Notes', ''],
    ['LD-1', 'orphan value', 'Pune', 'Maharashtra', 'first', null],
    ['LD-2', 'another', 'Nagpur', 'Maharashtra', 'second', null],
  ];
}

export function buildFixtureWorkbook(): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(loginData()), 'Login Data');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(manpowerSheet()), 'Manpower');
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(mappingChangesSheet()),
    'Mapping Changes Latest',
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(smSummarySheet()), 'SM Summary');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(leadDumpSheet()), 'Lead Dump');
  return workbook;
}

export function fixtureBuffer(bookType: 'xlsx' | 'xlsb'): Buffer {
  return XLSX.write(buildFixtureWorkbook(), { bookType, type: 'buffer' }) as Buffer;
}

/** Writes both formats to disk and returns their paths. */
export async function writeFixtures(): Promise<{ xlsx: string; xlsb: string }> {
  await mkdir(FIXTURE_DIR, { recursive: true });

  const paths = {
    xlsx: join(FIXTURE_DIR, 'sample-workbook.xlsx'),
    xlsb: join(FIXTURE_DIR, 'sample-workbook.xlsb'),
  };

  await writeFile(paths.xlsx, fixtureBuffer('xlsx'));
  await writeFile(paths.xlsb, fixtureBuffer('xlsb'));

  return paths;
}
