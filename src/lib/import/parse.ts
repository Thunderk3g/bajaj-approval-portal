import * as XLSX from 'xlsx';
import type { ParsedRow, ParsedSheet, SheetInfo, SourceColumn } from './types';

/**
 * Workbook reading — spec section 6.1.
 *
 * Three rules here are each a direct answer to something the real source file
 * does, and all three are load-bearing.
 */

/** The sheet the admin is offered first; it is the transaction sheet. */
export const DEFAULT_SHEET_NAME = 'Login Data';

/** Optional secondary sheets, imported alongside the transaction sheet (6.7). */
export const MAPPING_CHANGES_SHEET = 'Mapping Changes Latest';
export const MANPOWER_SHEET = 'Manpower';

// Which sheets are candidates lives in ./sheets, imported by the picker too —
// see the note there on why the two used to disagree.
import { isTransactionSheet } from './sheets';

export { isTransactionSheet };

export type WorkbookInput = ArrayBuffer | Uint8Array | Buffer;

function toBuffer(input: WorkbookInput): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  return Buffer.from(new Uint8Array(input));
}

/**
 * Cell-level options shared by every read.
 *
 * `raw: true` is the one that matters. Apps_No is a 10-digit number in the
 * source, and routing it through SheetJS's formatted text (`.w`) yields
 * `5.92E+09` — the identifier is destroyed before normalization ever sees it.
 * Turning off `cellText`, `cellHTML` and `cellFormula` stops that text being
 * generated at all, which also removes the temptation to read it.
 */
const CELL_OPTIONS = {
  raw: true,
  cellText: false,
  cellHTML: false,
  cellFormula: false,
  cellNF: false,
  cellStyles: false,
} as const;

function dimensions(sheet: XLSX.WorkSheet | undefined): { rows: number; columns: number } {
  // `!fullref` is set when `sheetRows` truncated the parse, and it carries the
  // sheet's real declared range — which is exactly what a listing needs and
  // exactly what `!ref` no longer says.
  const ref = (sheet?.['!fullref'] as string | undefined) ?? (sheet?.['!ref'] as string | undefined);
  if (!ref) return { rows: 0, columns: 0 };
  const range = XLSX.utils.decode_range(ref);
  return { rows: range.e.r - range.s.r + 1, columns: range.e.c - range.s.c + 1 };
}

/**
 * Lists the sheets without paying to parse them.
 *
 * `sheetRows: 1` stops SheetJS materialising cells past the first row of each
 * sheet. This is not a micro-optimisation: parsing all ten sheets of the real
 * workbook takes 37 s against 2.7 s for the two that matter, because `Lead
 * Dump` alone declares 54,508 rows x 16,383 columns of mostly-empty
 * formatting. An admin waiting 37 s just to see a list of sheet names would
 * reasonably conclude the upload had hung.
 */
export function listSheets(input: WorkbookInput): SheetInfo[] {
  const workbook = XLSX.read(toBuffer(input), { type: 'buffer', sheetRows: 1, ...CELL_OPTIONS });

  return workbook.SheetNames.map((name) => {
    const { rows, columns } = dimensions(workbook.Sheets[name]);
    return { name, rowCount: rows, columnCount: columns };
  });
}

/**
 * Picks the sheet to offer first: the known transaction sheet when it is there,
 * otherwise the largest sheet that is not one of the presentation tabs.
 */
export function suggestSheet(sheets: SheetInfo[]): string | null {
  const known = sheets.find((s) => s.name.toLowerCase() === DEFAULT_SHEET_NAME.toLowerCase());
  if (known) return known.name;

  const candidates = sheets
    .filter((s) => isTransactionSheet(s.name) && s.rowCount > 1)
    .sort((a, b) => b.rowCount - a.rowCount);

  // Falls back to nothing rather than to `sheets[0]`, which was reliably the
  // wrong answer: sheet zero of the real workbook is `Jan Target`, a
  // presentation tab. A null tells the screen to ask, where a bad default sends
  // the admin into a mapping form for a sheet with no policies in it.
  return candidates[0]?.name ?? null;
}

/**
 * Reads one sheet's cells, with the sheet allowlist that section 6.1 requires.
 *
 * The allowlist is the whole point of the parameter: without it SheetJS parses
 * every sheet in the workbook to hand back the one that was asked for.
 */
function loadSheet(input: WorkbookInput, sheetName: string, sheetRows?: number): XLSX.WorkSheet {
  const workbook = XLSX.read(toBuffer(input), {
    type: 'buffer',
    sheets: [sheetName],
    ...(sheetRows ? { sheetRows } : {}),
    ...CELL_OPTIONS,
  });

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" is not in this workbook`);
  return sheet;
}

/**
 * Builds the column list from a header row that may be malformed — and in the
 * real workbook, is.
 *
 * `Lead Dump` carries two columns both titled `Location` plus trailing untitled
 * ones. A blank header becomes `(column N)` so its data is still addressable,
 * and a repeated header is suffixed with its occurrence number so the second
 * `Location` cannot silently overwrite the first in the staged `raw` object.
 *
 * Trailing blank headers are dropped rather than synthesised. `Lead Dump`
 * declares 16,383 columns; 16,000 `(column N)` entries would bury the mapping
 * screen under columns that hold nothing at all.
 */
export function buildColumns(headerCells: unknown[]): SourceColumn[] {
  let last = -1;
  for (let i = 0; i < headerCells.length; i += 1) {
    const text = headerCells[i] === null || headerCells[i] === undefined ? '' : String(headerCells[i]).trim();
    if (text !== '') last = i;
  }
  if (last < 0) return [];

  const headers: string[] = [];
  for (let i = 0; i <= last; i += 1) {
    const cell = headerCells[i];
    headers.push(cell === null || cell === undefined ? '' : String(cell).trim().replace(/\s+/g, ' '));
  }

  const occurrences = new Map<string, number>();
  const totals = new Map<string, number>();
  for (const header of headers) {
    if (header !== '') totals.set(header, (totals.get(header) ?? 0) + 1);
  }

  return headers.map((header, index) => {
    if (header === '') {
      return { index, header: '', key: `(column ${index + 1})`, blank: true, duplicate: false };
    }

    const seen = (occurrences.get(header) ?? 0) + 1;
    occurrences.set(header, seen);
    const duplicate = (totals.get(header) ?? 0) > 1;

    return {
      index,
      header,
      key: duplicate ? `${header} (${seen})` : header,
      blank: false,
      duplicate,
    };
  });
}

export type ReadSheetOptions = {
  sheetName: string;
  /**
   * 1-based worksheet row holding the headers. Defaults to 1, and is a per-batch
   * setting because it genuinely varies: `Login Data` puts headers on row 1 but
   * `SM Summary` puts totals on row 1 and headers on row 2 (13.1).
   */
  headerRow?: number;
  /** Cap for previews. The mapping screen only needs a handful of sample rows. */
  maxRows?: number;
};

export function readSheet(input: WorkbookInput, options: ReadSheetOptions): ParsedSheet {
  const headerRow = Math.max(1, Math.floor(options.headerRow ?? 1));

  // `maxRows: 0` asks for the columns and nothing else — the export's
  // uploaded-layout mode. Truncating the parse there is not a nicety: the source
  // `.xlsb` costs ~75 s through SheetJS in full (which is why the Python ingest
  // service exists), and paying it to read one header row would put the export
  // past nginx's 180 s proxy timeout on a big book.
  const sheet = loadSheet(input, options.sheetName, options.maxRows === 0 ? headerRow : undefined);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
    range: headerRow - 1,
  });

  const columns = buildColumns(grid[0] ?? []);
  const rows: ParsedRow[] = [];
  const limit = options.maxRows ?? Number.POSITIVE_INFINITY;

  for (let i = 1; i < grid.length && rows.length < limit; i += 1) {
    const values = grid[i] ?? [];

    const cells: Record<string, unknown> = {};
    let populated = false;
    for (const column of columns) {
      const value = values[column.index] ?? null;
      cells[column.key] = value;
      if (value !== null && String(value).trim() !== '') populated = true;
    }

    // A wholly empty row is spreadsheet padding, not a record. Staging it would
    // produce a row whose only content is "Apps_No is required".
    if (!populated) continue;

    // `headerRow + i` is the true worksheet row: i is 1 for the first data row,
    // which sits immediately under the header. Reporting anything else would
    // send an admin to the wrong line in Excel.
    rows.push({ rowNumber: headerRow + i, cells });
  }

  return { sheetName: options.sheetName, headerRow, columns, rows };
}

/**
 * Reads the `Mapping Changes Latest` sheet — 292 rows of `App Number` -> `SM ID`
 * (spec section 6.7). Header spellings are matched loosely because this sheet is
 * hand-maintained and its two column names are not guaranteed stable.
 */
export function readMappingChanges(
  input: WorkbookInput,
  sheetName: string = MAPPING_CHANGES_SHEET,
): Array<{ appsNo: unknown; smId: unknown }> {
  const { columns, rows } = readSheet(input, { sheetName });

  const find = (needles: string[]) =>
    columns.find((c) => {
      const key = c.header.toLowerCase().replace(/[^a-z0-9]/g, '');
      return needles.includes(key);
    })?.key;

  const appColumn = find(['appnumber', 'appsno', 'appno', 'applicationno', 'applicationnumber']);
  const smColumn = find(['smid', 'smcode', 'newsmid', 'smidnew']);

  if (!appColumn || !smColumn) return [];

  return rows.map((row) => ({ appsNo: row.cells[appColumn], smId: row.cells[smColumn] }));
}

export type ManpowerRow = {
  smId: unknown;
  smName: unknown;
  tlId: unknown;
  tlName: unknown;
  ccmId: unknown;
  ccmName: unknown;
  location: unknown;
};

/** Reads the `Manpower` roster — the source of truth for `sm_name` (7.2, 13.1). */
export function readManpower(
  input: WorkbookInput,
  sheetName: string = MANPOWER_SHEET,
): ManpowerRow[] {
  const { columns, rows } = readSheet(input, { sheetName });

  const find = (needles: string[]) =>
    columns.find((c) => {
      const key = c.header.toLowerCase().replace(/[^a-z0-9]/g, '');
      return needles.includes(key);
    })?.key;

  const map = {
    smId: find(['smid', 'smcode', 'smempid']),
    smName: find(['smname', 'salesmanagername']),
    tlId: find(['tlid', 'tlcode']),
    tlName: find(['tlname', 'teamleadername']),
    ccmId: find(['ccmid', 'ccmcode']),
    ccmName: find(['ccmname']),
    location: find(['location', 'branch', 'city']),
  };

  if (!map.smId) return [];

  return rows.map((row) => ({
    smId: row.cells[map.smId!],
    smName: map.smName ? row.cells[map.smName] : null,
    tlId: map.tlId ? row.cells[map.tlId] : null,
    tlName: map.tlName ? row.cells[map.tlName] : null,
    ccmId: map.ccmId ? row.cells[map.ccmId] : null,
    ccmName: map.ccmName ? row.cells[map.ccmName] : null,
    location: map.location ? row.cells[map.location] : null,
  }));
}
