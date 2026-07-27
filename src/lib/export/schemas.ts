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
  issuedFrom: string | null;
  issuedTo: string | null;
  correctedOnly: boolean;
};

export const NO_FILTERS: ExportFilters = {
  batchId: null,
  smId: null,
  issuedFrom: null,
  issuedTo: null,
  correctedOnly: false,
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
    issuedFrom: z.preprocess(blankToNull, z.iso.date('Use the date picker').nullable()),
    issuedTo: z.preprocess(blankToNull, z.iso.date('Use the date picker').nullable()),
    correctedOnly: z.preprocess(toBoolean, z.boolean()),
  })
  .refine((f) => !f.issuedFrom || !f.issuedTo || f.issuedFrom <= f.issuedTo, {
    path: ['issuedTo'],
    message: 'The end of the range is before its start',
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
  if (filters.issuedFrom) parts.push(`Issued on or after ${filters.issuedFrom}`);
  if (filters.issuedTo) parts.push(`Issued on or before ${filters.issuedTo}`);
  if (filters.correctedOnly) parts.push('Corrected records only');
  return parts.length ? parts : ['All records'];
}
