/**
 * The gap filter in SQL must select exactly the rows `detectGaps` flags in JS.
 *
 * Two implementations of one rule (spec section 6.4) is a standing invitation
 * to drift: the grid would list one population while the badges on those very
 * rows describe another, and a rep would be told they have work that is not
 * there — or worse, not told about work that is. The fixture below deliberately
 * includes the near-misses that separate the two implementations: an
 * empty-string policy number, a tab-padded AutoPay, a non-breaking space, and a
 * lowercase padded status.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/db/client';
import { salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import type { PageParams } from '@/lib/pagination';
import { EMPTY_FILTERS, GAP_FILTERS, type GapFilter } from '@/lib/records/filters';
import { listRecords } from '@/lib/records/query';
import { detectGaps, type GapCandidate } from '@/lib/records/gaps';
import { makeUser, truncateAll } from '../helpers/db';

const PAGE: PageParams = { page: 1, pageSize: 100, offset: 0 };
const NBSP = String.fromCodePoint(0xa0);
const TAB = String.fromCodePoint(0x09);

let admin: SessionUser;

/**
 * One row per interesting combination, keyed by a readable apps_no.
 *
 * The §6.4 table is what makes most of these matter: every blank Issued_Date in
 * the June file belongs to a PENDING application, and 249 of 839 ISSUED rows
 * have no AutoPay. A naive blank check would flag the first group and a
 * whitespace-blind check would miss part of the second.
 */
const FIXTURE = [
  { appsNo: 'ISSUED-CLEAN', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: 'P1', autopay: 'Yes' },
  { appsNo: 'ISSUED-NO-AUTOPAY', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: 'P2', autopay: null },
  { appsNo: 'ISSUED-EMPTY-AUTOPAY', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: 'P3', autopay: '' },
  { appsNo: 'ISSUED-TAB-AUTOPAY', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: 'P4', autopay: TAB },
  { appsNo: 'ISSUED-NBSP-AUTOPAY', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: 'P5', autopay: NBSP },
  { appsNo: 'ISSUED-NO-POLICY', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: null, autopay: 'Yes' },
  { appsNo: 'ISSUED-EMPTY-POLICY', status: 'ISSUED', issuedDate: '2026-06-03', policyNo: '   ', autopay: 'Yes' },
  { appsNo: 'ISSUED-NO-DATE', status: 'ISSUED', issuedDate: null, policyNo: 'P6', autopay: 'Yes' },
  { appsNo: 'ISSUED-ALL-MISSING', status: 'ISSUED', issuedDate: null, policyNo: null, autopay: null },
  { appsNo: 'ISSUED-LOWER-PADDED', status: ` issued ${TAB}`, issuedDate: null, policyNo: null, autopay: null },
  { appsNo: 'ISSUED-MIXED-CASE', status: 'Issued', issuedDate: '2026-06-03', policyNo: 'P7', autopay: null },
  { appsNo: 'PENDING-ALL-BLANK', status: 'PENDING', issuedDate: null, policyNo: null, autopay: null },
  { appsNo: 'PENDING-PARTIAL', status: 'PENDING', issuedDate: null, policyNo: '', autopay: 'Yes' },
  { appsNo: 'REJECTED-ALL-BLANK', status: 'REJECTED', issuedDate: null, policyNo: null, autopay: null },
  { appsNo: 'NULL-STATUS', status: null, issuedDate: null, policyNo: null, autopay: null },
  { appsNo: 'EMPTY-STATUS', status: '', issuedDate: null, policyNo: null, autopay: null },
] as const;

beforeEach(async () => {
  await truncateAll();
  const row = await makeUser({ role: 'admin', smId: null });
  admin = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: 'admin',
    smId: null,
    isActive: true,
  };

  await db
    .insert(salesRecord)
    .values(FIXTURE.map((row) => ({ ...row, smId: 'ICCSP90766', extra: {} })));
});

/** The JS answer, computed from the rows as the database actually stored them. */
async function jsFlagged(gap: GapFilter): Promise<string[]> {
  const rows = await db.select().from(salesRecord);
  return rows
    .filter((row) => {
      const gaps = detectGaps(row as GapCandidate);
      return gap === 'ANY' ? gaps.length > 0 : gaps.includes(gap);
    })
    .map((row) => row.appsNo)
    .sort();
}

async function sqlFlagged(gap: GapFilter): Promise<string[]> {
  const { rows } = await listRecords(admin, { ...EMPTY_FILTERS, gap }, PAGE);
  return rows.map((row) => row.appsNo).sort();
}

describe('the SQL gap filter agrees with detectGaps', () => {
  it.each([...GAP_FILTERS])('agrees on %s over the same fixture rows', async (gap) => {
    const [sqlRows, jsRows] = await Promise.all([sqlFlagged(gap), jsFlagged(gap)]);
    expect(sqlRows).toEqual(jsRows);
    expect(sqlRows.length).toBeGreaterThan(0);
  });
});

describe('gaps are counted only on ISSUED rows (spec 6.4)', () => {
  it('flags no PENDING row, whatever is blank on it', async () => {
    const flagged = await sqlFlagged('ANY');
    expect(flagged).not.toContain('PENDING-ALL-BLANK');
    expect(flagged).not.toContain('PENDING-PARTIAL');
  });

  it('flags no REJECTED row', async () => {
    expect(await sqlFlagged('ANY')).not.toContain('REJECTED-ALL-BLANK');
  });

  it('flags no row whose status is null or blank', async () => {
    const flagged = await sqlFlagged('ANY');
    expect(flagged).not.toContain('NULL-STATUS');
    expect(flagged).not.toContain('EMPTY-STATUS');
  });

  it('reads a lowercase or padded status as ISSUED, exactly as detectGaps does', async () => {
    expect(await sqlFlagged('ANY')).toContain('ISSUED-LOWER-PADDED');
    expect(await sqlFlagged('MISSING_AUTOPAY')).toContain('ISSUED-MIXED-CASE');
  });

  it('treats an empty or whitespace-only value as missing', async () => {
    const missingAutopay = await sqlFlagged('MISSING_AUTOPAY');
    expect(missingAutopay).toEqual(
      expect.arrayContaining([
        'ISSUED-NO-AUTOPAY',
        'ISSUED-EMPTY-AUTOPAY',
        'ISSUED-TAB-AUTOPAY',
        'ISSUED-NBSP-AUTOPAY',
      ]),
    );
    expect(await sqlFlagged('MISSING_POLICY_NO')).toEqual(
      expect.arrayContaining(['ISSUED-NO-POLICY', 'ISSUED-EMPTY-POLICY']),
    );
  });

  it('never flags a complete ISSUED row', async () => {
    expect(await sqlFlagged('ANY')).not.toContain('ISSUED-CLEAN');
  });
});
