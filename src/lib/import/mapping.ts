import { CANONICAL_FIELDS, FIELD_BY_KEY, normalizeHeader } from '@/lib/fields';
import type { ColumnCandidate, ColumnMapping, MappingSuggestion, SourceColumn } from './types';

/**
 * Header auto-suggestion — spec section 6.2.
 *
 * Nothing in this pipeline is hardcoded to a header spelling. Four of the ten
 * fields the original requirement named do not exist under those names in the
 * real workbook (APE is `ANP`, FRP is `FP`, Issuance_Date is `Issued_Date`), and
 * next month's export may rename more. Scoring against an alias list absorbs
 * that; the admin's confirmed mapping is the authority, and every suggestion
 * here is overridable.
 */

/** Below this, a match is coincidence rather than a suggestion worth showing. */
const MIN_SCORE = 55;

const SCORES = { ALIAS: 100, LABEL: 90, PREFIX: 70, CONTAINS: 55 } as const;

function scoreColumn(column: SourceColumn, fieldKey: string): ColumnCandidate | null {
  const field = FIELD_BY_KEY.get(fieldKey);
  if (!field) return null;

  // A blank header carries no meaning to match on. Suggesting a field for
  // `(column 14)` would be a guess dressed up as a recommendation.
  if (column.blank) return null;

  const header = normalizeHeader(column.header);
  if (header === '') return null;

  if (field.aliases.includes(header)) {
    return { columnKey: column.key, fieldKey, score: SCORES.ALIAS, reason: 'ALIAS' };
  }

  if (normalizeHeader(field.label) === header) {
    return { columnKey: column.key, fieldKey, score: SCORES.LABEL, reason: 'LABEL' };
  }

  let best: ColumnCandidate | null = null;

  for (const alias of field.aliases) {
    // A two-character alias inside a long header is noise: `si` matches
    // `basba_si_flag` and `sm` matches `smsconsent`. Requiring the shorter side
    // to be at least four characters keeps `anp` and `fp` matching exactly (via
    // the alias branch above) without letting them float into unrelated columns.
    const shorter = Math.min(alias.length, header.length);
    if (shorter < 4) continue;

    const ratio = shorter / Math.max(alias.length, header.length);

    if (header.startsWith(alias) || alias.startsWith(header)) {
      const score = SCORES.PREFIX + Math.round(ratio * 20);
      if (!best || score > best.score) {
        best = { columnKey: column.key, fieldKey, score, reason: 'PREFIX' };
      }
      continue;
    }

    if (header.includes(alias) || alias.includes(header)) {
      const score = SCORES.CONTAINS + Math.round(ratio * 20);
      if (!best || score > best.score) {
        best = { columnKey: column.key, fieldKey, score, reason: 'CONTAINS' };
      }
    }
  }

  return best && best.score >= MIN_SCORE ? best : null;
}

/** Every column/field pair worth considering, best first. Exposed for tests. */
export function scoreCandidates(columns: SourceColumn[]): ColumnCandidate[] {
  const candidates: ColumnCandidate[] = [];

  for (const column of columns) {
    for (const field of CANONICAL_FIELDS) {
      const candidate = scoreColumn(column, field.key);
      if (candidate) candidates.push(candidate);
    }
  }

  // Deterministic order matters: two columns can tie, and a suggestion that
  // flips between page loads is one an admin stops trusting.
  return candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.fieldKey.localeCompare(b.fieldKey) ||
      a.columnKey.localeCompare(b.columnKey),
  );
}

/**
 * Greedily assigns the highest-scoring pairs, one column per field and one field
 * per column.
 *
 * The one-column-per-field constraint is what stops the two `Location` columns
 * of `Lead Dump` both claiming the same canonical field and the loser being
 * silently discarded — the second one stays unmapped and therefore lands in
 * `extra`.
 */
export function suggestMapping(columns: SourceColumn[]): MappingSuggestion {
  const mapping: ColumnMapping = {};
  const reasons: MappingSuggestion['reasons'] = {};
  const takenColumns = new Set<string>();

  for (const candidate of scoreCandidates(columns)) {
    if (mapping[candidate.fieldKey] || takenColumns.has(candidate.columnKey)) continue;
    mapping[candidate.fieldKey] = candidate.columnKey;
    takenColumns.add(candidate.columnKey);
    reasons[candidate.fieldKey] = {
      columnKey: candidate.columnKey,
      score: candidate.score,
      reason: candidate.reason,
    };
  }

  return {
    mapping,
    reasons,
    unmappedColumns: columns.filter((c) => !takenColumns.has(c.key)).map((c) => c.key),
  };
}

/**
 * Columns with no canonical home — spec section 5.4.
 *
 * These are not discarded. `FY`, `Login_Month`, `RECEIPT_NO`, `PPT`, `BT`,
 * `WROP`, `BASBA` and the rest go to `sales_record.extra`, so a workbook that
 * carries a column this spec never anticipated still imports losslessly and
 * stays searchable.
 */
export function unmappedColumns(columns: SourceColumn[], mapping: ColumnMapping): string[] {
  const mapped = new Set(Object.values(mapping));
  return columns.filter((c) => !mapped.has(c.key)).map((c) => c.key);
}

export type MappingProblem = { code: string; message: string; fieldKey?: string };

/**
 * Checks an admin-submitted mapping before it is stored.
 *
 * A mapping arriving from a form is user input like any other: it can name a
 * field that does not exist, point two fields at one column, or omit `Apps_No`
 * entirely — and the last of those would produce a batch in which every row
 * fails for the same reason, discovered only after a full parse.
 */
export function validateMapping(
  mapping: ColumnMapping,
  columns: SourceColumn[],
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const columnKeys = new Set(columns.map((c) => c.key));
  const usedBy = new Map<string, string>();

  for (const [fieldKey, columnKey] of Object.entries(mapping)) {
    if (!FIELD_BY_KEY.has(fieldKey)) {
      problems.push({ code: 'UNKNOWN_FIELD', fieldKey, message: `"${fieldKey}" is not a known field.` });
      continue;
    }
    if (!columnKeys.has(columnKey)) {
      problems.push({
        code: 'UNKNOWN_COLUMN',
        fieldKey,
        message: `Column "${columnKey}" is not in this sheet.`,
      });
      continue;
    }
    const owner = usedBy.get(columnKey);
    if (owner) {
      problems.push({
        code: 'COLUMN_REUSED',
        fieldKey,
        message: `Column "${columnKey}" is already mapped to ${owner}.`,
      });
      continue;
    }
    usedBy.set(columnKey, fieldKey);
  }

  for (const field of CANONICAL_FIELDS) {
    if (field.required && !mapping[field.key]) {
      problems.push({
        code: 'REQUIRED_UNMAPPED',
        fieldKey: field.key,
        message: `${field.label} must be mapped — no row can be committed without it.`,
      });
    }
  }

  return problems;
}
