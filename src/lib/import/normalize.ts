/**
 * Cell-level normalization — spec section 6.3.
 *
 * Every rule here exists because the real workbook broke a naive reading of it.
 * The measurements quoted in the comments come from the June extract profiled in
 * spec section 13 and are asserted by the unit tests, so a regression that
 * reintroduces the naive behaviour fails loudly instead of quietly corrupting a
 * month of data.
 */

export type NormalizeIssue = {
  field: string;
  code: string;
  severity: 'ERROR' | 'WARNING';
  message: string;
};

export type NormalizeResult<T> = {
  value: T | null;
  issues: NormalizeIssue[];
};

/**
 * THE most consequential rule in the importer.
 *
 * The source uses a literal hyphen, not an empty cell, to mean "no value":
 * 86% of Source, 100% of BASBA / LA Occupation / IP_GENDER, and 29% of AutoPay
 * are `-`. Treating `-` as data would make gap detection worthless, because the
 * fields most in need of reconciliation would every one of them read as
 * populated and the portal would report nothing to fix.
 */
const SENTINELS = new Set(['-', '--', 'na', 'n/a', 'null', 'nil', '#n/a', '#na', 'none', '']);

export function isSentinel(raw: unknown): boolean {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'number') return false;
  return SENTINELS.has(String(raw).trim().toLowerCase());
}

/** Trim, collapse internal whitespace, map sentinels to null. */
export function normalizeString(raw: unknown): string | null {
  if (isSentinel(raw)) return null;
  const text = String(raw).trim().replace(/\s+/g, ' ');
  return text === '' ? null : text;
}

/**
 * Identifier normalization: a raw number becomes its full integer string.
 *
 * Never route these through display text. The source workbook already renders
 * Apps_No as `5.92E+09` in places, and JavaScript's default number-to-string
 * does the same thing above 1e21. Both would silently destroy the identifier.
 * Fractional input is rejected rather than truncated — a fractional application
 * number means the column was mapped to the wrong source header.
 */
export function normalizeIdentifier(raw: unknown, field: string): NormalizeResult<string> {
  const issues: NormalizeIssue[] = [];
  if (isSentinel(raw)) return { value: null, issues };

  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      issues.push({ field, code: 'ID_NOT_FINITE', severity: 'ERROR', message: `${field} is not a finite number.` });
      return { value: null, issues };
    }
    if (!Number.isInteger(raw)) {
      issues.push({
        field,
        code: 'ID_FRACTIONAL',
        severity: 'ERROR',
        message: `${field} "${raw}" has a fractional part; identifiers must be whole numbers.`,
      });
      return { value: null, issues };
    }
    return { value: BigInt(raw).toString(), issues };
  }

  const text = String(raw).trim();
  // Scientific notation arriving as text is the display-formatted form of a
  // number that was already lossy before it reached us. Expanding it would
  // invent digits, so it is refused outright.
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) {
    issues.push({
      field,
      code: 'ID_SCIENTIFIC_NOTATION',
      severity: 'ERROR',
      message: `${field} "${text}" is in scientific notation; the source column must be read as a number, not display text.`,
    });
    return { value: null, issues };
  }

  const cleaned = text.replace(/\s+/g, '');
  if (cleaned === '') return { value: null, issues };
  if (/^\d+$/.test(cleaned)) return { value: cleaned.replace(/^0+(?=\d)/, ''), issues };

  // Non-numeric identifiers are kept verbatim: spec section 13.2 note 7 records a
  // purely numeric orphan SM_ID, and nothing guarantees future application
  // numbers stay numeric.
  return { value: cleaned, issues };
}

/**
 * SM_ID is always uppercased. This is not cosmetic.
 *
 * The June file holds 164 distinct SM_ID values that collapse to 158 once
 * uppercased — six reps appear in both cases (`c2cm21350` and `C2CM21350`).
 * Without this, those six each see a partial view of their own book, with the
 * remainder invisible and therefore unfixable. A database CHECK constraint
 * enforces the same rule on `sales_record`, so a write that skips this fails.
 */
export function normalizeSmId(raw: unknown): NormalizeResult<string> {
  const issues: NormalizeIssue[] = [];
  const text = normalizeString(raw);
  if (text === null) return { value: null, issues };
  return { value: text.replace(/\s+/g, '').toUpperCase(), issues };
}

/**
 * Money to a `numeric(18,2)`-safe decimal string.
 *
 * Returned as a string, never a JS number: `fp` and `anp` are premium values and
 * binary floating point would accumulate drift across import, correction and
 * export. The source already carries fractional premiums (FP = 4195.42), so the
 * drift would be real, not theoretical.
 */
export function normalizeMoney(raw: unknown, field: string): NormalizeResult<string> {
  const issues: NormalizeIssue[] = [];
  if (isSentinel(raw)) return { value: null, issues };

  const text = String(raw)
    .trim()
    .replace(/[₹$€£,\s]/g, '');

  if (text === '') return { value: null, issues };

  // Accounting parentheses are a negative, and a negative premium is an error
  // either way — but recognising the form gives a better message than
  // "unparseable".
  const parenthesised = /^\((.+)\)$/.exec(text);
  const body = parenthesised ? `-${parenthesised[1]}` : text;

  if (!/^[+-]?\d+(\.\d+)?$/.test(body)) {
    issues.push({
      field,
      code: 'MONEY_UNPARSEABLE',
      severity: 'ERROR',
      message: `Could not read "${String(raw)}" as an amount.`,
    });
    return { value: null, issues };
  }

  const amount = Number(body);
  if (amount < 0) {
    issues.push({
      field,
      code: 'MONEY_NEGATIVE',
      severity: 'ERROR',
      message: `${field} is negative (${body}).`,
    });
    return { value: null, issues };
  }

  // Rounds to two decimals through a decimal-string path rather than
  // toFixed on the parsed float, so the stored value is exactly what the
  // source said to the cent.
  const [whole, fraction = ''] = body.replace(/^\+/, '').split('.');
  const cents = (fraction + '00').slice(0, 2);
  const rounded = fraction.length > 2 && Number(fraction[2]) >= 5;
  const value = rounded
    ? (Number(`${whole}.${cents}`) + 0.01).toFixed(2)
    : `${whole}.${cents}`;

  return { value, issues };
}

/**
 * AutoPay vocabulary — spec section 6.3.
 *
 * The June file contains only `Y` (725), `-` (339) and empty (107): there is no
 * `No` value at all, which is exactly why 38% of the column needs reconciling.
 * The field is really "confirmed" or "unknown", and mapping the sentinel to NULL
 * rather than to "No" is what keeps that distinction visible.
 *
 * An unrecognised token is a WARNING, not an ERROR, and the raw text is handed
 * back so the row still commits and the value stays inspectable.
 */
export function normalizeAutopay(raw: unknown): NormalizeResult<string> {
  const issues: NormalizeIssue[] = [];
  if (isSentinel(raw)) return { value: null, issues };

  const token = String(raw).trim().toUpperCase();

  if (['Y', 'YES', 'TRUE', '1', 'ACTIVE'].includes(token)) return { value: 'Yes', issues };
  if (['N', 'NO', 'FALSE', '0', 'INACTIVE'].includes(token)) return { value: 'No', issues };

  issues.push({
    field: 'autopay',
    code: 'AUTOPAY_UNRECOGNISED',
    severity: 'WARNING',
    message: `AutoPay value "${String(raw)}" is outside the known vocabulary; kept as-is.`,
  });
  return { value: String(raw).trim(), issues };
}

/** Status columns are uppercased and trimmed — spec section 6.3. */
export function normalizeStatus(raw: unknown): NormalizeResult<string> {
  const text = normalizeString(raw);
  return { value: text === null ? null : text.toUpperCase(), issues: [] };
}

/** Convenience for callers that only care whether anything blocked the row. */
export function hasError(issues: readonly NormalizeIssue[]): boolean {
  return issues.some((i) => i.severity === 'ERROR');
}
