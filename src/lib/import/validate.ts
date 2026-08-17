import type { RowIssue } from '@/db/schema';
import { CANONICAL_FIELDS, fieldLabel, type FieldKind } from '@/lib/fields';
import { detectGaps } from '@/lib/records/gaps';
import { DEFAULT_DATE_FORMAT, normalizeDate, type DateFormat } from './dates';
import {
  isSentinel,
  normalizeAutopay,
  normalizeIdentifier,
  normalizeMoney,
  normalizeSmId,
  normalizeStatus,
  normalizeString,
  type NormalizeResult,
} from './normalize';
import {
  REPORT_LIST_CAP,
  type ColumnMapping,
  type FieldConflict,
  type MasterRecordSnapshot,
  type ParsedRow,
  type ParsedSheet,
  type RowProblem,
  type SourceColumn,
  type ValidatedRow,
  type ValidationReport,
} from './types';

/**
 * Row validation — spec sections 6.3, 6.4, 6.5, 6.6 and the conflict half of 6.8.
 *
 * Deliberately free of database access. Everything it needs about existing
 * master records arrives as a plain map, so the whole severity model, the
 * duplicate rules and the conflict policy are unit-testable without a
 * connection — and the integration tests then only have to prove the wiring.
 *
 * Severity, spec section 6.5: ERROR blocks a row from commit; WARNING commits
 * and is reported. Nothing is ever dropped quietly — every skipped row appears
 * in the report with its worksheet row number.
 */

/** The row-scope pseudo-field for issues that belong to no single column. */
const ROW_SCOPE = '_row';

function issue(
  field: string,
  code: string,
  severity: 'ERROR' | 'WARNING',
  message: string,
): RowIssue {
  return { field, code, severity, message };
}

/**
 * Dispatches a cell to the normalizer its canonical field's `kind` names.
 *
 * `smId` is the one field whose handling is not implied by its kind: it is
 * plain text as far as the column type goes, but it must be uppercased, because
 * the June file holds six reps who appear in both cases and would otherwise
 * each see half their own book (spec section 6.3).
 */
export function normalizeCell(
  fieldKey: string,
  kind: FieldKind,
  raw: unknown,
  dateFormat: DateFormat,
): NormalizeResult<string> {
  if (fieldKey === 'smId') return normalizeSmId(raw);

  switch (kind) {
    case 'identifier':
      return normalizeIdentifier(raw, fieldKey);
    case 'money':
      return normalizeMoney(raw, fieldKey);
    case 'date':
      // The sentinel check happens here rather than inside `normalizeDate`,
      // which judges only whether text parses as a date and would call "-" an
      // unparseable date. It is not a bad date; it is the source's way of
      // writing "no value", and 105 PENDING rows carry it in `Issued_Date`.
      // Treating those as errors would block a fifth of every batch.
      return isSentinel(raw) ? { value: null, issues: [] } : normalizeDate(raw, dateFormat, fieldKey);
    case 'autopay':
      return normalizeAutopay(raw);
    case 'status':
      return normalizeStatus(raw);
    case 'text':
      return { value: normalizeString(raw), issues: [] };
  }
}

/**
 * Booking frequency to the ANP/FP multiplier — spec section 13.2 note 8.
 *
 * `ANP = FP x multiplier` holds exactly in the source (12 for Monthly, 1 for
 * Annual). Quarterly and half-yearly are included because the vocabulary is not
 * closed and a future extract may carry them; an unrecognised frequency simply
 * skips the check rather than inventing a multiplier to compare against.
 */
const FREQUENCY_MULTIPLIER: Record<string, number> = {
  monthly: 12,
  mly: 12,
  month: 12,
  quarterly: 4,
  qly: 4,
  quarter: 4,
  halfyearly: 2,
  halfyear: 2,
  semiannual: 2,
  semiannually: 2,
  hly: 2,
  annual: 1,
  annually: 1,
  yearly: 1,
  yly: 1,
  single: 1,
  singlepay: 1,
  singlepremium: 1,
};

function multiplierFor(frequency: string | null): number | null {
  if (!frequency) return null;
  return FREQUENCY_MULTIPLIER[frequency.toLowerCase().replace(/[^a-z]/g, '')] ?? null;
}

/**
 * Money as integer paise. Comparing premiums through JS floats is exactly the
 * drift `numeric(18,2)` exists to prevent, and a ratio check is no excuse to
 * reintroduce it — 4195.42 * 12 is not 50345.04 in binary floating point.
 */
// Written through the BigInt constructor rather than as `100n` literals: the
// project targets ES2017, where the literal form is a compile error.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED = BigInt(100);

function toMinorUnits(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  return BigInt(match[1]) * HUNDRED + BigInt((match[2] ?? '').padEnd(2, '0'));
}

/**
 * Warns when the ANP/FP ratio contradicts `Booking_Frequency`.
 *
 * A warning, never an error: the relationship is an observed property of one
 * month's extract, not a rule the source system guarantees, and blocking a row
 * over it would refuse to import real premiums on the strength of a heuristic.
 */
export function checkAnpFpRatio(normalized: Record<string, string | null>): RowIssue[] {
  const fp = normalized.fp;
  const anp = normalized.anp;
  const multiplier = multiplierFor(normalized.bookingFrequency ?? null);

  if (!fp || !anp || multiplier === null) return [];

  const fpUnits = toMinorUnits(fp);
  const anpUnits = toMinorUnits(anp);
  if (fpUnits === null || anpUnits === null || fpUnits === ZERO) return [];

  const expected = fpUnits * BigInt(multiplier);
  const drift = anpUnits > expected ? anpUnits - expected : expected - anpUnits;

  // One percent of the expected value, plus a paisa, absorbs the rounding the
  // source itself applies without letting a wrong multiplier slip through.
  if (drift <= expected / HUNDRED + ONE) return [];

  return [
    issue(
      'anp',
      'ANP_FP_RATIO_MISMATCH',
      'WARNING',
      `ANP ${anp} is not FP ${fp} x ${multiplier} for booking frequency "${normalized.bookingFrequency}".`,
    ),
  ];
}

/**
 * Every source column with no canonical home — spec section 5.4.
 *
 * These are preserved, never discarded: `FY`, `Login_Month`, `RECEIPT_NO`,
 * `PPT`, `BT`, `WROP`, `BASBA` and anything a future workbook invents all land
 * in `sales_record.extra` and stay searchable. Derived from the raw row rather
 * than carried alongside it, so the staged `raw` jsonb and the committed
 * `extra` can never disagree about what was in the file.
 *
 * Sentinels are dropped here too. Section 6.3 says `-` means NULL "for every
 * column", and it is 86% of `Source` and 100% of `BASBA`, `LA Occupation` and
 * `IP_GENDER` — storing them would make a search for a populated extra column
 * match almost every record in the table.
 */
export function extraFromRaw(
  raw: Record<string, unknown>,
  mapping: ColumnMapping,
): Record<string, unknown> {
  const mapped = new Set(Object.values(mapping));
  const extra: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (mapped.has(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      extra[key] = value;
      continue;
    }
    const text = normalizeString(value);
    if (text !== null) extra[key] = text;
  }

  return extra;
}

export type ValidateOptions = {
  columns: SourceColumn[];
  mapping: ColumnMapping;
  dateFormat?: DateFormat;
  /**
   * Master records keyed by normalized Apps_No — spec sections 6.6 and 6.8.
   * Absent means "nothing has been imported yet", not "do not check".
   */
  existing?: ReadonlyMap<string, MasterRecordSnapshot>;
};

/** Normalizes one parsed row without any cross-row knowledge. */
export function validateRow(
  row: ParsedRow,
  options: ValidateOptions,
): Omit<ValidatedRow, 'isDuplicate' | 'duplicateOfRow' | 'status' | 'updatesExisting'> {
  const dateFormat = options.dateFormat ?? DEFAULT_DATE_FORMAT;
  const normalized: Record<string, string | null> = {};
  const issues: RowIssue[] = [];

  for (const field of CANONICAL_FIELDS) {
    const columnKey = options.mapping[field.key];
    if (!columnKey) {
      normalized[field.key] = null;
      continue;
    }

    const result = normalizeCell(field.key, field.kind, row.cells[columnKey], dateFormat);
    normalized[field.key] = result.value;
    issues.push(...result.issues);

    if (field.required && result.value === null && !result.issues.some((i) => i.severity === 'ERROR')) {
      issues.push(
        issue(
          field.key,
          'REQUIRED_MISSING',
          'ERROR',
          `${field.label} is required and column "${columnKey}" is empty on this row.`,
        ),
      );
    }
  }

  issues.push(...checkAnpFpRatio(normalized));

  return {
    rowNumber: row.rowNumber,
    raw: row.cells,
    normalized,
    extra: extraFromRaw(row.cells, options.mapping),
    issues,
    gaps: detectGaps({
      status: normalized.status ?? null,
      issuedDate: normalized.issuedDate ?? null,
      policyNo: normalized.policyNo ?? null,
      autopay: normalized.autopay ?? null,
    }),
  };
}

export type ValidationOutcome = {
  rows: ValidatedRow[];
  conflicts: FieldConflict[];
  gapsBySmId: Map<string, number>;
};

/**
 * Validates a whole sheet, adding the cross-row rules: duplicate `Apps_No`
 * (section 6.6) and the re-import conflicts of section 6.8.
 */
export function validateRows(rows: ParsedRow[], options: ValidateOptions): ValidationOutcome {
  const existing = options.existing ?? new Map<string, MasterRecordSnapshot>();

  const validated: ValidatedRow[] = [];
  const conflicts: FieldConflict[] = [];
  const gapsBySmId = new Map<string, number>();
  const firstSeenAt = new Map<string, number>();

  for (const row of rows) {
    const base = validateRow(row, options);
    const appsNo = base.normalized.appsNo;
    const issues = base.issues;

    let isDuplicate = false;
    let duplicateOfRow: number | null = null;

    if (appsNo) {
      const seenAt = firstSeenAt.get(appsNo);
      if (seenAt !== undefined) {
        // The first occurrence is authoritative; later ones are held back rather
        // than dropped, because a silently discarded row is indistinguishable
        // from a row that was never in the file.
        isDuplicate = true;
        duplicateOfRow = seenAt;
        issues.push(
          issue(
            ROW_SCOPE,
            'DUPLICATE_IN_BATCH',
            'WARNING',
            `Apps_No ${appsNo} already appears on row ${seenAt}; that row is treated as authoritative.`,
          ),
        );
      } else {
        firstSeenAt.set(appsNo, row.rowNumber);
      }
    }

    const master = appsNo && !isDuplicate ? existing.get(appsNo) : undefined;

    if (master) {
      issues.push(
        issue(
          ROW_SCOPE,
          'DUPLICATE_OF_EXISTING',
          'WARNING',
          `Apps_No ${appsNo} already exists; this row updates the stored record.`,
        ),
      );

      // Spec section 6.8. Silently reverting an approved, evidenced correction
      // because someone re-uploaded a stale export is the most damaging failure
      // this system could have, so a field carrying an approved correction is
      // never overwritten by an import. The disagreement is escalated to the
      // admin as a CONFLICT instead of being resolved by whoever uploaded last.
      for (const field of master.protectedFields) {
        const incoming = base.normalized[field] ?? null;
        const current = master.values[field] ?? null;
        if (incoming === null || incoming === current) continue;

        conflicts.push({
          rowNumber: row.rowNumber,
          appsNo: master.appsNo,
          field,
          label: fieldLabel(field),
          currentValue: current,
          incomingValue: incoming,
        });

        issues.push(
          issue(
            field,
            'APPROVED_CORRECTION_CONFLICT',
            'WARNING',
            `${fieldLabel(field)} carries an approved correction ("${current ?? '—'}"); the file says "${incoming}". The stored value is kept unless you accept the file value.`,
          ),
        );
      }
    }

    const hasError = issues.some((i) => i.severity === 'ERROR');
    const status: ValidatedRow['status'] = hasError ? 'INVALID' : isDuplicate ? 'DUPLICATE' : 'VALID';

    if (status === 'VALID' && base.gaps.length > 0 && base.normalized.smId) {
      const smId = base.normalized.smId;
      gapsBySmId.set(smId, (gapsBySmId.get(smId) ?? 0) + 1);
    }

    validated.push({
      ...base,
      issues,
      isDuplicate,
      duplicateOfRow,
      status,
      updatesExisting: Boolean(master),
    });
  }

  return { rows: validated, conflicts, gapsBySmId };
}

function problemsOf(rows: ValidatedRow[], severity: 'ERROR' | 'WARNING'): RowProblem[] {
  const out: RowProblem[] = [];
  for (const row of rows) {
    const issues = row.issues.filter((i) => i.severity === severity);
    if (issues.length === 0) continue;
    out.push({ rowNumber: row.rowNumber, appsNo: row.normalized.appsNo ?? null, issues });
  }
  return out;
}

export type ReportContext = {
  sheet: Pick<ParsedSheet, 'sheetName' | 'headerRow' | 'columns'>;
  dateFormat: DateFormat;
  mapping: ColumnMapping;
  secondarySheets?: { mappingChanges: string | null; manpower: string | null };
};

export function buildValidationReport(
  outcome: ValidationOutcome,
  context: ReportContext,
): ValidationReport {
  const { rows, conflicts, gapsBySmId } = outcome;

  const errors = problemsOf(rows, 'ERROR');
  const warnings = problemsOf(rows, 'WARNING');
  const duplicates = rows
    .filter((r) => r.isDuplicate && r.duplicateOfRow !== null)
    .map((r) => ({
      rowNumber: r.rowNumber,
      appsNo: r.normalized.appsNo ?? '',
      duplicateOfRow: r.duplicateOfRow as number,
    }));

  // Skipped means "will not reach sales_record": both the error rows and the
  // held-back duplicates. Listing the row numbers is what section 6.5 means by
  // nothing failing silently.
  const skipped = rows.filter((r) => r.status !== 'VALID').map((r) => r.rowNumber);

  const mapped = new Set(Object.values(context.mapping));

  return {
    generatedAt: new Date().toISOString(),
    sheetName: context.sheet.sheetName,
    headerRow: context.sheet.headerRow,
    dateFormat: context.dateFormat,
    totals: {
      rows: rows.length,
      valid: rows.filter((r) => r.status === 'VALID').length,
      invalid: rows.filter((r) => r.status === 'INVALID').length,
      duplicate: rows.filter((r) => r.status === 'DUPLICATE').length,
      warnings: warnings.length,
      conflicts: conflicts.length,
      newRecords: rows.filter((r) => r.status === 'VALID' && !r.updatesExisting).length,
      updatedRecords: rows.filter((r) => r.status === 'VALID' && r.updatesExisting).length,
    },
    errors: errors.slice(0, REPORT_LIST_CAP),
    warnings: warnings.slice(0, REPORT_LIST_CAP),
    duplicates: duplicates.slice(0, REPORT_LIST_CAP),
    conflicts: conflicts.slice(0, REPORT_LIST_CAP),
    skippedRowNumbers: skipped.slice(0, REPORT_LIST_CAP),
    gapsBySmId: Object.fromEntries(gapsBySmId),
    unmappedColumns: context.sheet.columns.filter((c) => !mapped.has(c.key)).map((c) => c.key),
    secondarySheets: context.secondarySheets ?? { mappingChanges: null, manpower: null },
    truncated:
      errors.length > REPORT_LIST_CAP ||
      warnings.length > REPORT_LIST_CAP ||
      duplicates.length > REPORT_LIST_CAP ||
      conflicts.length > REPORT_LIST_CAP ||
      skipped.length > REPORT_LIST_CAP,
  };
}
