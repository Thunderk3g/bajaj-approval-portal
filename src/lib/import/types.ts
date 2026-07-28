import type { RowIssue } from '@/db/schema';
import type { DateFormat } from './dates';
import type { GapType } from '@/lib/records/gaps';

/**
 * The vocabulary shared by parse -> map -> validate -> stage -> commit.
 *
 * It lives in its own module because the pipeline is deliberately layered: the
 * pure stages (parse, mapping, validate) must stay importable from a unit test
 * with no database and no session, and a type imported from `stage.ts` would
 * drag `@/db/client` — and therefore a live connection pool — into every one of
 * those tests.
 */

/** A sheet as the workbook advertises it, before any of its cells are read. */
export type SheetInfo = {
  name: string;
  /** Rows including the header row, from the sheet's declared dimensions. */
  rowCount: number;
  columnCount: number;
};

export type SourceColumn = {
  /** Zero-based sheet position. This is what disambiguates repeated headers. */
  index: number;
  /** Header text exactly as the sheet spells it; empty when the cell is blank. */
  header: string;
  /**
   * The unique handle: the key in the staged `raw` object and the value an
   * admin's column mapping points at. Equal to `header` in the ordinary case.
   */
  key: string;
  /** Header cell was empty, so `key` is a synthesised `(column N)`. */
  blank: boolean;
  /** Another column in the same sheet carries the same header text. */
  duplicate: boolean;
};

export type ParsedRow = {
  /** 1-based worksheet row, so a reported problem can be found in Excel itself. */
  rowNumber: number;
  cells: Record<string, unknown>;
};

export type ParsedSheet = {
  sheetName: string;
  headerRow: number;
  columns: SourceColumn[];
  rows: ParsedRow[];
};

/* ----------------------------------------------------------------- mapping */

export type MatchReason = 'ALIAS' | 'LABEL' | 'PREFIX' | 'CONTAINS';

export type ColumnCandidate = {
  columnKey: string;
  fieldKey: string;
  score: number;
  reason: MatchReason;
};

/** Canonical field key -> source column key. Mirrors `upload_batch.column_mapping`. */
export type ColumnMapping = Record<string, string>;

export type MappingSuggestion = {
  /** Canonical field key -> the column the scorer picked, or null for none. */
  mapping: ColumnMapping;
  /** Why each suggestion was made, for the "auto-matched" hint on the screen. */
  reasons: Record<string, { columnKey: string; score: number; reason: MatchReason }>;
  /** Columns with no canonical home. These land in `sales_record.extra`. */
  unmappedColumns: string[];
};

/* -------------------------------------------------------------- validation */

export type ValidatedRow = {
  rowNumber: number;
  raw: Record<string, unknown>;
  /** Canonical field key -> normalized value. Money stays a string throughout. */
  normalized: Record<string, string | null>;
  /** Every source column with no canonical mapping — preserved, never binned. */
  extra: Record<string, unknown>;
  issues: RowIssue[];
  isDuplicate: boolean;
  duplicateOfRow: number | null;
  status: 'VALID' | 'INVALID' | 'DUPLICATE';
  /** Status-conditional, per spec section 6.4 — never a naive blank check. */
  gaps: GapType[];
  /** True when this Apps_No already exists in the master table. */
  updatesExisting: boolean;
};

/**
 * What validation needs to know about a record that already exists.
 *
 * `protectedFields` is the heart of spec section 6.8: the canonical fields that
 * carry an APPROVED correction and therefore must survive a re-import that
 * disagrees with them.
 */
export type MasterRecordSnapshot = {
  id: string;
  appsNo: string;
  values: Record<string, string | null>;
  protectedFields: string[];
};

export type FieldConflict = {
  rowNumber: number;
  appsNo: string;
  field: string;
  label: string;
  /** The approved value currently on the record — the one being protected. */
  currentValue: string | null;
  /** What the file says instead. Applied only if the admin explicitly accepts. */
  incomingValue: string | null;
};

export type RowProblem = {
  rowNumber: number;
  appsNo: string | null;
  issues: RowIssue[];
};

export type DuplicateReport = {
  rowNumber: number;
  appsNo: string;
  duplicateOfRow: number;
};

/**
 * The jsonb written to `upload_batch.validation_report` and rendered on the
 * review screen.
 *
 * Problem lists are capped (`truncated` says so) because a mis-mapped column
 * can make every row in a 54,000-row sheet fail, and a jsonb column holding
 * 54,000 issue arrays is a way to take the review page down with the very
 * report that is supposed to explain the failure.
 */
export type ValidationReport = {
  generatedAt: string;
  sheetName: string;
  headerRow: number;
  dateFormat: DateFormat;
  totals: {
    rows: number;
    valid: number;
    invalid: number;
    duplicate: number;
    warnings: number;
    conflicts: number;
    newRecords: number;
    updatedRecords: number;
  };
  errors: RowProblem[];
  warnings: RowProblem[];
  duplicates: DuplicateReport[];
  conflicts: FieldConflict[];
  /** Row numbers that will be skipped at commit, so nothing fails silently. */
  skippedRowNumbers: number[];
  /** Per-SM gap counts, reused verbatim by the batch-committed notification. */
  gapsBySmId: Record<string, number>;
  unmappedColumns: string[];
  secondarySheets: {
    mappingChanges: string | null;
    manpower: string | null;
  };
  truncated: boolean;
};

export const REPORT_LIST_CAP = 500;

/* ------------------------------------------------------------------ commit */

/** Apps_No -> canonical field keys whose file value the admin accepted (6.8). */
export type ConflictAcceptance = Record<string, string[]>;

export type CommitOutcome = {
  inserted: number;
  updated: number;
  skipped: number;
  conflictsResolved: number;
  conflictsHeld: number;
  mappingChangesApplied: number;
  mappingChangesUnmatched: number;
  manpowerUpserted: number;
  orphanSmIds: string[];
  notified: number;
  /** The cycle these records now belong to — 2026-07-28 spec section 4.3. */
  period: { code: string; label: string };
  /**
   * Periods this commit closed, by label. Almost always zero or one.
   *
   * Reported because closing is a side effect of committing and an admin who is
   * not told about it will not know that reps have just lost the ability to
   * raise new corrections against last month.
   */
  periodsClosed: string[];
};
