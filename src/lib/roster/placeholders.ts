/**
 * Codes the Manpower sheet carries that are not people.
 *
 * The roster has a row for each of these, so "is it on the roster" answers yes
 * and every screen that trusted that question offered them as reps to provision.
 * They are buckets:
 *
 *   111222-UN  the source's own marker for a lead nobody has been given yet
 *              (`UNASSIGNED_SM_CODE` in ingest/app/leads.py, ~2.7% of rows)
 *   DIY        the digital channel — policies sold with no rep attached, which
 *              is exactly what the MAPPING_DIY chain exists to route
 *
 * An account for either would be a login nobody can be held to, and on the
 * manager rungs it would be worse: a placeholder that APPROVES things.
 *
 * Its own module because four callers need it — the worklist, bulk provisioning,
 * and the two CLI scripts — and it was previously restated in each. A list of
 * "not a person" codes that disagrees between the screen and the script is how
 * one of them provisions a bucket.
 */
const PLACEHOLDER_CODES = new Set(['111222-UN', 'DIY']);

/** True when this code names a bucket rather than somebody who can sign in. */
export function isPlaceholderCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return PLACEHOLDER_CODES.has(code.trim().toUpperCase());
}

/** For a SQL `not in (...)`, uppercase as the roster stores them. */
export const PLACEHOLDER_CODE_LIST = [...PLACEHOLDER_CODES];

export const PLACEHOLDER_REASON =
  'a placeholder in the source data, not a person — it marks unassigned or digital-channel business';
