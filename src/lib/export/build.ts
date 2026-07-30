import { Workbook, type Cell, type Row, type Worksheet } from 'exceljs';
import type { InferSelectModel } from 'drizzle-orm';
import type { salesRecord } from '@/db/schema';
import { CANONICAL_FIELDS, FIELD_BY_KEY, type FieldKind } from '@/lib/fields';
import { describeFilters, type ExportFilters } from './schemas';

/**
 * The Excel writer — spec section 8.
 *
 * A NEW workbook every time. The uploaded file is never opened for writing: it
 * is the evidence that the original values were what the record claims they
 * were (spec 5.5), and a library that rewrites it — even losslessly — destroys
 * that property the moment anyone asks whether the file on disk is the file
 * that was received.
 *
 * ExcelJS rather than SheetJS because two of the three requirements below
 * (highlight fill, cell comment) are things SheetJS Community Edition cannot
 * write at all. SheetJS stays on the read side, where it is the only library
 * that opens the `.xlsb` source.
 */

export const SHEET_MASTER = 'Master Data';
export const SHEET_CORRECTIONS = 'Corrections Log';
export const SHEET_INFO = 'Export Info';

/**
 * The highlight applied to a cell carrying an approved correction. Exported so
 * the test asserts the same colour the writer used rather than a copy of it
 * that can silently drift.
 */
export const CORRECTED_FILL_ARGB = 'FFFFE28A';

const HEADER_FILL_ARGB = 'FFE2E8F0';

const TEXT_FORMAT = '@';
const MONEY_FORMAT = '#,##0.00';
const DATE_FORMAT = 'dd-mmm-yyyy';
const DATETIME_FORMAT = 'dd-mmm-yyyy hh:mm';

/** Derived from the table so a schema column added later cannot silently miss the export. */
export type ExportRecord = InferSelectModel<typeof salesRecord>;

export type ExportCorrection = {
  id: string;
  recordId: string;
  appsNo: string;
  category: string;
  fieldName: string;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string;
  description: string | null;
  smId: string;
  submitterName: string | null;
  submitterEmail: string | null;
  submittedAt: Date;
  /**
   * The first gate — 2026-07-28 spec section 3.5.
   *
   * Carried separately from the approver, not folded into a single "reviewed
   * by". An export is the artefact that leaves the system and gets argued over;
   * one that names only the approver cannot answer whether a wrong value got
   * through because the verifier missed it or because the approver overrode
   * them, and that is the first question anyone asks.
   */
  verifierName: string | null;
  verifierEmail: string | null;
  verifiedAt: Date | null;
  verifierRemarks: string | null;
  approverName: string | null;
  approverEmail: string | null;
  status: string;
  approverRemarks: string | null;
  reviewedAt: Date | null;
  appliedAt: Date | null;
  /** The reconciliation cycle this claim was raised in. Null pre-dates periods. */
  periodLabel: string | null;
};

export type ExportMeta = {
  fileName: string;
  generatedAt: Date;
  generatedByName: string;
  generatedByEmail: string;
  filters: ExportFilters;
  /** Human label for the source batch, or null when the export spans every batch. */
  batchLabel: string | null;
};

/**
 * The uploaded sheet's own column layout.
 *
 * Present when the admin asked for the export to come back in the shape of the
 * file they handed in: same headers, same order, nothing appended. The updated
 * values sit in their original columns and a corrected cell is highlighted, so
 * the file is diffable against the source by eye.
 *
 * Read back off the stored original rather than reconstructed from
 * `upload_batch.column_mapping`, which records which column fed which field but
 * not where the columns sat or what the unmapped ones were called.
 */
export type SourceLayout = {
  /** The batch's sheet, used as the worksheet name. */
  sheetName: string;
  /**
   * Every source column in worksheet order. `fieldKey` is set for the columns
   * the import mapped to a canonical field; the rest are read from `extra` by
   * `key`, which is exactly how the importer stored them.
   */
  columns: Array<{ key: string; header: string; fieldKey: string | null }>;
};

export type ExportInput = {
  records: ExportRecord[];
  corrections: ExportCorrection[];
  meta: ExportMeta;
  /** Set to write the source sheet's layout instead of the canonical one. */
  sourceLayout?: SourceLayout | null;
  /**
   * period id → label, for the `Period` column on Master Data.
   *
   * A lookup rather than a join onto each record: an export can span thousands
   * of records but only a handful of periods, so carrying the label on every row
   * from the database would repeat the same dozen strings a thousand times over
   * the wire.
   */
  periodLabels?: Map<string, string>;
};

/* ------------------------------------------------------------------ values */

/**
 * Converts a `numeric(18,2)` string to the double Excel will store.
 *
 * Postgres hands money back as a string precisely so it never passes through a
 * float (spec section 3), and this is the single deliberate crossing of that
 * line — the export has to be usable for arithmetic, and a text cell is not.
 * The conversion goes through the integer paise count rather than parsing the
 * decimal directly, which also makes the one genuinely lossy case detectable:
 * `numeric(18,2)` reaches 10^18 paise, well past 2^53, where a double can no
 * longer name every value. Beyond that the caller writes text — a number that
 * is quietly wrong is worse than a cell that cannot be summed.
 */
export function moneyToExcelNumber(value: string): number | null {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;

  const [, sign, whole, fraction = ''] = match;
  const paise = BigInt(whole + fraction.padEnd(2, '0'));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return null;

  const magnitude = Number(paise) / 100;
  return sign === '-' ? -magnitude : magnitude;
}

/**
 * Turns a `YYYY-MM-DD` date column into the Date ExcelJS serializes.
 *
 * Built at UTC midnight on purpose: ExcelJS computes the serial from
 * `date.getTime()`, so a Date built with local-time components lands on a
 * fractional serial and Excel renders "03-Jun-2026 18:30" for a date-only
 * column. UTC midnight gives a whole serial in every timezone the server
 * might run in.
 */
export function isoDateToExcelDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

type PreparedCell = { value: string | number | boolean | Date | null; numFmt?: string };

/** Writes a canonical column, typed by its registry `kind` rather than by guessing. */
export function prepareCanonicalCell(kind: FieldKind, raw: unknown): PreparedCell {
  if (raw === null || raw === undefined || raw === '') return { value: null };

  switch (kind) {
    case 'identifier': {
      // Apps_No and Policy_No are text everywhere (spec 5.4). Writing them as
      // numbers is what puts 5.92E+09 back on the screen, which is the display
      // the whole schema was shaped to avoid.
      return { value: String(raw), numFmt: TEXT_FORMAT };
    }
    case 'money': {
      const amount = moneyToExcelNumber(String(raw));
      return amount === null
        ? { value: String(raw), numFmt: TEXT_FORMAT }
        : { value: amount, numFmt: MONEY_FORMAT };
    }
    case 'date': {
      const date = raw instanceof Date ? raw : isoDateToExcelDate(String(raw));
      return date === null ? { value: String(raw) } : { value: date, numFmt: DATE_FORMAT };
    }
    default:
      return { value: String(raw) };
  }
}

/**
 * Writes a preserved `extra` column, whose type is whatever the source
 * workbook happened to hold.
 *
 * Large integers go out as text. `extra` carries `RECEIPT_NO` and
 * `Product_Code` (spec 5.4) — identifiers that are numeric only by accident,
 * and Excel switches its General format to scientific notation past eleven
 * digits. Anything shorter stays numeric so a column like `PPT` is still
 * summable.
 */
export function prepareExtraCell(raw: unknown): PreparedCell {
  if (raw === null || raw === undefined) return { value: null };
  if (typeof raw === 'boolean') return { value: raw };

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: String(raw), numFmt: TEXT_FORMAT };
    if (Number.isInteger(raw) && Math.abs(raw) >= 1e11) {
      return { value: raw.toFixed(0), numFmt: TEXT_FORMAT };
    }
    return { value: raw };
  }

  if (typeof raw === 'string') return { value: raw };
  return { value: JSON.stringify(raw) };
}

/**
 * The `extra` columns to emit, unioned across every exported row.
 *
 * Unioning matters because `extra` is per-record: a column that only some
 * workbooks carried exists on only some rows, and taking the first row's keys
 * would drop it from the export entirely. Order is first-seen, which preserves
 * the source workbook's own column order for the common case where all rows
 * came from one import.
 */
export function extraColumnKeys(records: ExportRecord[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];

  for (const record of records) {
    const extra = record.extra;
    if (!extra || typeof extra !== 'object') continue;
    for (const key of Object.keys(extra)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }

  return keys;
}

/** UTC because Excel has no timezone concept — an unlabelled local time is a lie. */
function instantText(value: Date | null | undefined): string {
  if (!value) return '—';
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The comment body on a corrected cell.
 *
 * Original value, approver and approval date, because the cell now shows the
 * approved value and the reader's next question is always "what did it say
 * before, and who changed it?". Without this the export is indistinguishable
 * from one where the source data was simply different.
 */
export function correctionNote(correction: ExportCorrection): string {
  const lines = [
    `Original value: ${correction.originalValue ?? '(blank)'}`,
    `Approved value: ${correction.proposedValue}`,
  ];

  // Both gates, in the order they happened. A reader hovering a highlighted cell
  // is asking "who is accountable for this number" — naming one of the two
  // people involved answers half the question.
  if (correction.verifierName ?? correction.verifierEmail) {
    lines.push(
      `Verified by: ${correction.verifierName ?? correction.verifierEmail}`,
      `Verified on: ${instantText(correction.verifiedAt)}`,
    );
  }

  lines.push(
    `Approved by: ${correction.approverName ?? correction.approverEmail ?? 'unknown approver'}`,
    `Approved on: ${instantText(correction.appliedAt ?? correction.reviewedAt)}`,
  );

  return lines.join('\n');
}

/* ------------------------------------------------------------------ sheets */

function styleHeaderRow(row: Row, columnCount: number): void {
  row.font = { bold: true };
  for (let i = 1; i <= columnCount; i += 1) {
    row.getCell(i).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: HEADER_FILL_ARGB },
    };
  }
  row.commit();
}

function applyPrepared(row: Row, cells: PreparedCell[]): void {
  cells.forEach((cell, index) => {
    if (cell.numFmt) row.getCell(index + 1).numFmt = cell.numFmt;
  });
}

/** Widths are sized off the header text; an unsized sheet opens as a wall of `####`. */
function sizeColumns(sheet: Worksheet, headers: string[]): void {
  headers.forEach((header, index) => {
    sheet.getColumn(index + 1).width = Math.min(40, Math.max(12, header.length + 2));
  });
}

function annotateCorrectedCell(cell: Cell, correction: ExportCorrection): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CORRECTED_FILL_ARGB } };
  cell.note = correctionNote(correction);
}

/**
 * Indexes applied corrections by record, then by field.
 *
 * Last write wins per field, and the corrections arrive ordered by application
 * time — so a field corrected twice is annotated with the change that actually
 * produced the value now in the cell, not the first one.
 */
function indexCorrections(
  corrections: ExportCorrection[],
): Map<string, Map<string, ExportCorrection>> {
  const byRecord = new Map<string, Map<string, ExportCorrection>>();

  for (const correction of corrections) {
    let fields = byRecord.get(correction.recordId);
    if (!fields) {
      fields = new Map();
      byRecord.set(correction.recordId, fields);
    }
    fields.set(correction.fieldName, correction);
  }

  return byRecord;
}

/** Excel rejects `[]:*?/\` in a tab name and truncates past 31 characters. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned === '' ? SHEET_MASTER : cleaned;
}

/**
 * The uploaded sheet, updated in place.
 *
 * Deliberately adds no columns: no `Period`, no correction summary. The whole
 * point is a file whose columns line up with the one that was handed in, so an
 * appended column — however useful elsewhere — is the thing that breaks it.
 * The corrections are still recorded, on the `Corrections Log` sheet and in the
 * comment on each highlighted cell.
 */
function addSourceLayoutSheet(
  workbook: Workbook,
  input: ExportInput,
  layout: SourceLayout,
): void {
  const sheet = workbook.addWorksheet(safeSheetName(layout.sheetName), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // Verbatim, including a blank one: a synthesised name would put a header on a
  // column the source left untitled.
  const headers = layout.columns.map((column) => column.header);

  styleHeaderRow(sheet.addRow(headers), headers.length);
  sizeColumns(sheet, headers);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const byRecord = indexCorrections(input.corrections);

  for (const record of input.records) {
    const applied = byRecord.get(record.id);
    const values = record as unknown as Record<string, unknown>;
    const extra = (record.extra ?? {}) as Record<string, unknown>;

    const cells = layout.columns.map((column) => {
      const field = column.fieldKey ? FIELD_BY_KEY.get(column.fieldKey) : undefined;
      // No field means the column was never mapped, so its value only ever
      // lived in `extra` under the source column key.
      return field
        ? prepareCanonicalCell(field.kind, values[field.key])
        : prepareExtraCell(extra[column.key]);
    });

    const row = sheet.addRow(cells.map((cell) => cell.value));
    applyPrepared(row, cells);

    if (!applied) continue;
    layout.columns.forEach((column, index) => {
      const correction = column.fieldKey ? applied.get(column.fieldKey) : undefined;
      if (correction) annotateCorrectedCell(row.getCell(index + 1), correction);
    });
  }
}

function addMasterSheet(workbook: Workbook, input: ExportInput): void {
  if (input.sourceLayout) {
    addSourceLayoutSheet(workbook, input, input.sourceLayout);
    return;
  }

  const sheet = workbook.addWorksheet(SHEET_MASTER, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  const extraKeys = extraColumnKeys(input.records);

  // Column order and header labels come from CANONICAL_FIELDS — the same
  // registry the importer maps source headers against. Driving both ends off
  // one list is what stops the export drifting from the import; a per-batch
  // source order would also make a multi-batch export incoherent, since two
  // workbooks need not agree on column order.
  const headers = [
    ...CANONICAL_FIELDS.map((field) => field.label),
    ...extraKeys,
    'Period',
    'Corrected_Fields',
    'Correction_Count',
    'Last_Corrected_On',
  ];

  styleHeaderRow(sheet.addRow(headers), headers.length);
  sizeColumns(sheet, headers);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  const byRecord = indexCorrections(input.corrections);

  for (const record of input.records) {
    const applied = byRecord.get(record.id);
    const values = record as unknown as Record<string, unknown>;
    const extra = (record.extra ?? {}) as Record<string, unknown>;

    const correctedFields = applied ? [...applied.values()] : [];
    const lastCorrectedOn = correctedFields.reduce<Date | null>((latest, correction) => {
      const at = correction.appliedAt ?? correction.reviewedAt;
      if (!at) return latest;
      return latest === null || at > latest ? at : latest;
    }, null);

    const cells: PreparedCell[] = [
      ...CANONICAL_FIELDS.map((field) => prepareCanonicalCell(field.kind, values[field.key])),
      ...extraKeys.map((key) => prepareExtraCell(extra[key])),
      { value: record.periodId ? (input.periodLabels?.get(record.periodId) ?? null) : null },
      { value: correctedFields.map((c) => c.fieldLabel).join(', ') || null },
      { value: correctedFields.length },
      lastCorrectedOn ? { value: lastCorrectedOn, numFmt: DATETIME_FORMAT } : { value: null },
    ];

    const row = sheet.addRow(cells.map((cell) => cell.value));
    applyPrepared(row, cells);

    if (!applied) continue;
    CANONICAL_FIELDS.forEach((field, index) => {
      const correction = applied.get(field.key);
      if (correction) annotateCorrectedCell(row.getCell(index + 1), correction);
    });
  }
}

function addCorrectionsSheet(workbook: Workbook, input: ExportInput): void {
  const sheet = workbook.addWorksheet(SHEET_CORRECTIONS, {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // Both review stages, in the order they occur, so the sheet reads left to
  // right as the request actually travelled: raised → verified → decided.
  const headers = [
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
  ];

  styleHeaderRow(sheet.addRow(headers), headers.length);
  sizeColumns(sheet, headers);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  for (const correction of input.corrections) {
    const cells: PreparedCell[] = [
      { value: correction.appsNo, numFmt: TEXT_FORMAT },
      { value: correction.periodLabel },
      { value: correction.fieldLabel },
      { value: correction.originalValue },
      { value: correction.proposedValue },
      { value: correction.category },
      { value: correction.description },
      { value: correction.submitterName ?? correction.submitterEmail },
      { value: correction.smId },
      { value: correction.submittedAt, numFmt: DATETIME_FORMAT },
      { value: correction.verifierName ?? correction.verifierEmail },
      correction.verifiedAt
        ? { value: correction.verifiedAt, numFmt: DATETIME_FORMAT }
        : { value: null },
      { value: correction.verifierRemarks },
      { value: correction.approverName ?? correction.approverEmail },
      { value: correction.status },
      { value: correction.approverRemarks },
      correction.reviewedAt
        ? { value: correction.reviewedAt, numFmt: DATETIME_FORMAT }
        : { value: null },
    ];

    applyPrepared(
      sheet.addRow(cells.map((cell) => cell.value)),
      cells,
    );
  }
}

/**
 * The provenance sheet.
 *
 * A spreadsheet that leaves the system loses its context immediately — it gets
 * mailed on, renamed, and argued over. Everything needed to reproduce it, or
 * to say what it does and does not contain, travels inside the file.
 */
function addInfoSheet(workbook: Workbook, input: ExportInput): void {
  const sheet = workbook.addWorksheet(SHEET_INFO);
  const headers = ['Item', 'Value'];

  styleHeaderRow(sheet.addRow(headers), headers.length);
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 64;

  const { meta } = input;
  const rows: Array<[string, PreparedCell]> = [
    ['File name', { value: meta.fileName }],
    ['Generated by', { value: meta.generatedByName }],
    ['Generated by (email)', { value: meta.generatedByEmail }],
    ['Generated at', { value: meta.generatedAt, numFmt: DATETIME_FORMAT }],
    ['Generated at (UTC)', { value: instantText(meta.generatedAt) }],
    ['Filters applied', { value: describeFilters(meta.filters).join('; ') }],
    ['Filter — batch', { value: meta.filters.batchId }],
    ['Filter — SM_ID', { value: meta.filters.smId }],
    ['Filter — issued from', { value: meta.filters.issuedFrom }],
    ['Filter — issued to', { value: meta.filters.issuedTo }],
    ['Filter — corrected records only', { value: meta.filters.correctedOnly ? 'Yes' : 'No' }],
    ['Layout', { value: input.sourceLayout ? `Uploaded sheet "${input.sourceLayout.sheetName}"` : 'Canonical columns' }],
    ['Source batch', { value: meta.batchLabel ?? 'All batches' }],
    ['Records exported', { value: input.records.length }],
    ['Corrections applied', { value: input.corrections.length }],
    ['Preserved extra columns', { value: extraColumnKeys(input.records).length }],
  ];

  for (const [label, cell] of rows) {
    const row = sheet.addRow([label, cell.value]);
    if (cell.numFmt) row.getCell(2).numFmt = cell.numFmt;
    row.getCell(1).font = { bold: true };
  }
}

/* ----------------------------------------------------------------- writing */

export function buildExportWorkbook(input: ExportInput): Workbook {
  const workbook = new Workbook();
  workbook.creator = input.meta.generatedByEmail;
  workbook.created = input.meta.generatedAt;

  addMasterSheet(workbook, input);
  addCorrectionsSheet(workbook, input);
  addInfoSheet(workbook, input);

  return workbook;
}

/**
 * Serializes to a buffer rather than writing straight to disk.
 *
 * The caller hashes the same bytes it stores, so `excel_export.sha256` cannot
 * describe a file that differs from the one on disk — which is what a
 * write-then-read-back-and-hash sequence risks the moment anything else touches
 * the path in between.
 */
export async function exportWorkbookBuffer(input: ExportInput): Promise<Buffer> {
  const written = await buildExportWorkbook(input).xlsx.writeBuffer();
  return Buffer.from(written as unknown as ArrayBuffer);
}

/** Writes straight to a path. Used by tests and by any caller that does not need the bytes. */
export async function writeExportWorkbook(input: ExportInput, absolutePath: string): Promise<void> {
  await buildExportWorkbook(input).xlsx.writeFile(absolutePath);
}

/**
 * `sales-reconciliation-<YYYYMMDD-HHmm>-v<n>.xlsx` — spec section 8.
 *
 * Local wall-clock time, because the only reader of this name is the admin who
 * pressed the button and they match it against their own clock. It is a label,
 * never a key: the file lives at a UUID path under `storage/exports/`, so two
 * exports that race to the same `v<n>` still cannot overwrite each other.
 */
export function exportFileName(now: Date, version: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `sales-reconciliation-${stamp}-v${version}.xlsx`;
}
