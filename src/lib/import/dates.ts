import { isSentinel, type NormalizeIssue, type NormalizeResult } from './normalize';

/**
 * Date handling for import — spec section 6.3.
 *
 * The observed form in the source workbook is an Excel serial number, but a
 * later export could equally arrive as a native date or a formatted string, so
 * all three are accepted. What is NOT accepted is guessing between `dd/MM` and
 * `MM/dd`: `03/04/2026` is either 3 April or 4 March, and picking wrong
 * corrupts data in a way that leaves no trace. The batch carries an explicit
 * `dateFormat` and this module obeys it.
 */

export const DATE_FORMATS = ['dd/MM/yyyy', 'dd-MM-yyyy', 'yyyy-MM-dd', 'MM/dd/yyyy'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const DEFAULT_DATE_FORMAT: DateFormat = 'dd/MM/yyyy';

/** Values outside this window are surfaced as WARNING, not ERROR — section 6.3. */
const MIN_PLAUSIBLE = Date.UTC(1990, 0, 1);

/**
 * Excel serial number to an ISO `YYYY-MM-DD` string.
 *
 * Excel's 1900 system contains a deliberate bug: it treats 1900 as a leap year,
 * so serial 60 is the non-existent 29 February 1900 and every serial from 61
 * onward is one day ahead of a naive count from 1900-01-01. Anchoring at
 * 1899-12-30 for serials >= 60 absorbs that offset; serials <= 59 predate the
 * phantom day and anchor at 1899-12-31.
 *
 * Verified against the source workbook: 46176 -> 2026-06-03 and
 * 46211 -> 2026-07-08, the observed Issued_Date range in spec section 13.2.
 */
export function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const whole = Math.floor(serial);
  const base = whole <= 59 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
  const ms = base + whole * 86_400_000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  // Rejects 31 April and 29 February in a common year: the Date constructor
  // rolls those forward, so a round-trip mismatch means the input was invalid.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseFormatted(text: string, format: DateFormat): string | null {
  const parts = text.split(/[/\-.]/).map((p) => p.trim());
  if (parts.length !== 3) return null;
  if (parts.some((p) => !/^\d+$/.test(p))) return null;

  const [a, b, c] = parts.map((p) => Number(p));

  switch (format) {
    case 'dd/MM/yyyy':
    case 'dd-MM-yyyy':
      return iso(c, b, a);
    case 'MM/dd/yyyy':
      return iso(c, a, b);
    case 'yyyy-MM-dd':
      return iso(a, b, c);
  }
}

/**
 * Normalizes any supported date representation to `YYYY-MM-DD`.
 *
 * Returns `{ value: null, issues: [] }` for a genuinely absent value — an
 * unissued policy legitimately has no issuance date (spec section 6.4), so
 * blankness is not by itself a defect and this function does not judge it.
 * Whether a blank matters is decided by gap detection, which knows the status.
 *
 * Absence includes the `-` sentinel, and routing it through `isSentinel` rather
 * than checking for an empty string is load-bearing. The source workbook writes
 * a literal hyphen for "no value", and 105 PENDING rows carry one in
 * `Issued_Date`. Treating that as an unparseable date would mark every one of
 * them INVALID and block them from commit — turning the single most common
 * correct state in the file into a blocking error.
 */
export function normalizeDate(
  raw: unknown,
  format: DateFormat = DEFAULT_DATE_FORMAT,
  fieldLabel = 'date',
): NormalizeResult<string> {
  const issues: NormalizeIssue[] = [];

  // isSentinel deliberately returns false for a number, so Excel serial 0 and
  // any other numeric input still reach the parser below.
  if (isSentinel(raw)) return { value: null, issues };

  let value: string | null = null;

  if (raw instanceof Date) {
    value = Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10);
  } else if (typeof raw === 'number') {
    value = excelSerialToISO(raw);
  } else {
    const text = String(raw).trim();
    if (text === '') return { value: null, issues };
    // A numeric string is still a serial — SheetJS returns text when the cell
    // was formatted as text, and the digits mean the same thing either way.
    if (/^\d+(\.\d+)?$/.test(text) && Number(text) > 366) {
      value = excelSerialToISO(Number(text));
    } else {
      value = parseFormatted(text, format);
    }
  }

  if (value === null) {
    issues.push({
      field: fieldLabel,
      code: 'DATE_UNPARSEABLE',
      severity: 'ERROR',
      message: `Could not read "${String(raw)}" as a date using ${format}.`,
    });
    return { value: null, issues };
  }

  const ms = Date.parse(`${value}T00:00:00Z`);
  const maxPlausible = Date.now() + 366 * 86_400_000;
  if (ms < MIN_PLAUSIBLE || ms > maxPlausible) {
    issues.push({
      field: fieldLabel,
      code: 'DATE_OUT_OF_RANGE',
      severity: 'WARNING',
      message: `${value} falls outside 1990-01-01 to one year from today.`,
    });
  }

  return { value, issues };
}
