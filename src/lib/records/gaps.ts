/**
 * Status-conditional gap detection — spec section 6.4.
 *
 * A blank field is not automatically a defect, and the June data proves it:
 *
 *   Status    Rows   No Issued_Date   No Policy_No   No AutoPay
 *   ISSUED     839         0                3            249
 *   PENDING    174       105              105            113
 *   REJECTED   158         0                0             84
 *
 * Every blank Issued_Date in the file belongs to a PENDING application, which is
 * correct rather than broken — an unissued policy has no issuance date. A naive
 * "field is empty" rule raises 105 false tasks for Issued_Date and 105 more for
 * Policy_No, burying the 250 genuine ones. Gaps are therefore only counted on
 * ISSUED rows.
 *
 * The unit tests assert those exact counts against the fixture, so a refactor
 * that reintroduces blank-checking fails instead of flooding the queue.
 */

export const GAP_TYPES = ['MISSING_ISSUED_DATE', 'MISSING_POLICY_NO', 'MISSING_AUTOPAY'] as const;
export type GapType = (typeof GAP_TYPES)[number];

export const GAP_LABELS: Record<GapType, string> = {
  MISSING_ISSUED_DATE: 'Missing issuance date',
  MISSING_POLICY_NO: 'Missing policy number',
  MISSING_AUTOPAY: 'Missing AutoPay',
};

/** The record shape gap detection needs — deliberately narrow. */
export type GapCandidate = {
  status: string | null;
  issuedDate: string | Date | null;
  policyNo: string | null;
  autopay: string | null;
};

/** The one status under which a blank is actionable. */
export const ISSUED_STATUS = 'ISSUED';

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === '';
}

export function detectGaps(record: GapCandidate): GapType[] {
  // Status is stored uppercased by normalizeStatus, but a record read straight
  // from a caller's own query might not be, so compare defensively.
  if ((record.status ?? '').trim().toUpperCase() !== ISSUED_STATUS) return [];

  const gaps: GapType[] = [];
  if (isBlank(record.issuedDate)) gaps.push('MISSING_ISSUED_DATE');
  if (isBlank(record.policyNo)) gaps.push('MISSING_POLICY_NO');
  if (isBlank(record.autopay)) gaps.push('MISSING_AUTOPAY');
  return gaps;
}

export function hasGap(record: GapCandidate): boolean {
  return detectGaps(record).length > 0;
}

/**
 * An ISSUED application with no policy number is a true anomaly — only three
 * exist in the June file — and spec section 6.4 asks for them at the top of the
 * admin dashboard rather than buried in the general gap count.
 */
export function isAnomalous(record: GapCandidate): boolean {
  return detectGaps(record).includes('MISSING_POLICY_NO');
}
