import { z } from 'zod';

/**
 * The export filter set — spec section 8.
 *
 * The normalized shape is stored verbatim on `excel_export.filters`, and every
 * key is present even when unused. An absent key and a null key are
 * indistinguishable once the row is a year old, and "was this export scoped to
 * one rep, or was the column simply not written yet?" is exactly the question a
 * reconciliation dispute asks. Recording `null` states the fact.
 */

export type ExportFilters = {
  batchId: string | null;
  smId: string | null;
  /**
   * The reconciliation month, as its `YYYY-MM` code — spec section 4.
   *
   * The code rather than `period.id` for the same reason the label is stored on
   * the period row: this blob is read back a year later, and `2026-07` still
   * says July while a UUID says nothing. `exportConditions` translates it to the
   * `period_id` the record actually carries.
   *
   * Not the same question as `issuedFrom`/`issuedTo`. The period is the cycle a
   * record was RECONCILED in, stamped by the import that carried it; the issued
   * dates are when the policy was issued. A June policy first seen in the July
   * workbook belongs to July's dashboard and falls outside a June date range.
   */
  periodCode: string | null;
  issuedFrom: string | null;
  issuedTo: string | null;
  correctedOnly: boolean;
  /**
   * Write the batch's own sheet back out instead of the canonical layout.
   *
   * Not a filter on the rows, but it lives here because it is part of what
   * produced the file, and `excel_export.filters` is the only record of that.
   * "Why does last month's export have different columns?" is otherwise
   * unanswerable a year later.
   */
  sourceLayout: boolean;
};

export const NO_FILTERS: ExportFilters = {
  batchId: null,
  smId: null,
  periodCode: null,
  issuedFrom: null,
  issuedTo: null,
  correctedOnly: false,
  sourceLayout: false,
};

/**
 * A FormData control that was never touched arrives as `''`, not as absent.
 * Left alone, `''` would reach the query as a real value and match nothing —
 * an empty export that looks like an empty database.
 */
function blankToNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** An unchecked checkbox is omitted from FormData entirely; a checked one is `'on'`. */
function toBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = blankToNull(value);
  return text === 'on' || text === 'true' || text === '1' || text === 'yes';
}

export const exportFiltersSchema = z
  .object({
    batchId: z.preprocess(blankToNull, z.uuid('Pick a batch from the list').nullable()),
    smId: z.preprocess(
      (value) => {
        const text = blankToNull(value);
        // SM_ID is uppercase everywhere (spec 6.3); a lowercase filter would
        // match nothing against rows the uppercase CHECK constraint guarantees.
        return text === null ? null : text.toUpperCase();
      },
      z
        .string()
        .max(64, 'SM ID is too long')
        .regex(/^[A-Z0-9._-]+$/, 'SM ID contains characters no rep code uses')
        .nullable(),
    ),
    periodCode: z.preprocess(
      blankToNull,
      z
        .string()
        .regex(/^\d{4}-\d{2}$/, 'Pick a month from the list')
        .nullable(),
    ),
    issuedFrom: z.preprocess(blankToNull, z.iso.date('Use the date picker').nullable()),
    issuedTo: z.preprocess(blankToNull, z.iso.date('Use the date picker').nullable()),
    correctedOnly: z.preprocess(toBoolean, z.boolean()),
    sourceLayout: z.preprocess(toBoolean, z.boolean()),
  })
  .refine((f) => !f.issuedFrom || !f.issuedTo || f.issuedFrom <= f.issuedTo, {
    path: ['issuedTo'],
    message: 'The end of the range is before its start',
  })
  // A column layout belongs to one uploaded file. Two batches need not agree on
  // their columns, so an unscoped export has no single sheet to reproduce.
  .refine((f) => !f.sourceLayout || f.batchId !== null, {
    path: ['sourceLayout'],
    message: 'Pick the batch whose layout you want',
  });

/**
 * Reads a filter set back off a stored `excel_export` row.
 *
 * Falls back to "no filters" rather than throwing: a past export whose filter
 * blob predates a schema change is still a downloadable file, and refusing to
 * render the list because one historical row is unparseable would take the
 * whole page down with it.
 */
export function coerceFilters(value: unknown): ExportFilters {
  const parsed = exportFiltersSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : NO_FILTERS;
}

/**
 * One phrasing of the filter set, shared by the exports list and the
 * `Export Info` sheet.
 *
 * `batchNames` is optional because the batch a past export was scoped to may
 * have scrolled out of the caller's list, and a raw UUID is still a truthful
 * answer — better than omitting the fact that the export was scoped at all.
 */
export function describeFilters(
  filters: ExportFilters,
  batchNames?: ReadonlyMap<string, string>,
): string[] {
  const parts: string[] = [];
  if (filters.batchId) parts.push(`Batch ${batchNames?.get(filters.batchId) ?? filters.batchId}`);
  if (filters.smId) parts.push(`SM_ID ${filters.smId}`);
  if (filters.periodCode) parts.push(`Period ${filters.periodCode}`);
  if (filters.issuedFrom) parts.push(`Issued on or after ${filters.issuedFrom}`);
  if (filters.issuedTo) parts.push(`Issued on or before ${filters.issuedTo}`);
  if (filters.correctedOnly) parts.push('Corrected records only');
  if (filters.sourceLayout) parts.push('Uploaded sheet layout');
  return parts.length ? parts : ['All records'];
}
