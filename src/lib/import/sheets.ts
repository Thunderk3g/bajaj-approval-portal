/**
 * Which sheets of a workbook can be the transaction sheet.
 *
 * Its own module, importing nothing, because both sides of the decision need it:
 * `parse.ts` suggests a sheet on the server and the picker offers the list in the
 * browser. `parse.ts` pulls in SheetJS, so a client component importing the
 * predicate from there would ship the whole spreadsheet reader to the browser to
 * answer a string comparison.
 *
 * They used to hold SEPARATE definitions, and that is the bug this file exists to
 * close: the server excluded four presentation tabs, the picker excluded only
 * `Lead Dump`, and neither excluded `Manpower`. Picking `Manpower` therefore
 * repointed the batch at it and scored its seven roster columns against
 * `CANONICAL_FIELDS` — where `Apps_No` and `SM_ID` are required — so the admin
 * got a column-mapping error for a sheet nobody is meant to map.
 */

/** Presentation tabs. No rows anyone imports (spec 13.1). */
const PRESENTATION = ['Jan Target', 'BFL & BAU', 'Overall Dashboard', 'Dash'];

/**
 * Data sheets that already have their own importer, each finding itself by name:
 * `Manpower` via `commitRoster`, `Mapping Changes Latest` via the commit's
 * secondary pass, `Lead Dump` via the Python ingestion service.
 *
 * `Lead Dump` in particular must never be selectable. Reading it through the
 * sheet reader materialises its declared 54,508 x 16,383 range and asks for
 * roughly 28 GB; the admin got a FAILED job quoting that number with nothing to
 * say the sheet was simply the wrong choice.
 */
const OWN_PIPELINE = [
  'Manpower',
  'Mapping Changes Latest',
  'Lead Dump',
  'Product Details',
  'SM Summary',
];

const EXCLUDED = new Set([...PRESENTATION, ...OWN_PIPELINE].map((s) => s.toLowerCase()));

/** Matched case-insensitively on the trimmed name, as the ingestion service does. */
export function isTransactionSheet(name: string): boolean {
  return !EXCLUDED.has(name.trim().toLowerCase());
}

/** Why a sheet is not offered, for the line under the picker. */
export function sheetExclusionReason(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (!EXCLUDED.has(key)) return null;
  return OWN_PIPELINE.some((s) => s.toLowerCase() === key)
    ? 'imported by its own step, not mapped here'
    : 'a presentation tab, not data';
}
