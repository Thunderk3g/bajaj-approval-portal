/**
 * Can a sales user reach a lead that is not theirs? (spec section 6.2.)
 *
 * Every assertion below is that one question asked a different way: through the
 * list, through the count, through the summary counters, through a search term,
 * through the `smCode` parameter, through a date range, through the unassigned
 * pool. If a refactor drops `scopedLeadCondition` from any single path, exactly
 * one of these fails — which is why they are written one path at a time rather
 * than as a single happy-path check.
 *
 * Leads are read-only and join to nothing, so there is no detail route, no
 * version chain and no correction path to test here. The list *is* the surface.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { AuthzError } from '@/lib/auth/errors';
import type { Role, SessionUser } from '@/lib/auth/rbac';
import { db } from '@/db/client';
import { lead, manpower } from '@/db/schema';
import { DEFAULT_PAGE_SIZE, type PageParams } from '@/lib/pagination';
import {
  EMPTY_LEAD_FILTERS,
  parseLeadFilters,
  type LeadFilters,
} from '@/lib/leads/filters';
import { countLeads, leadSummary, listLeads, listOrphanCodes } from '@/lib/leads/queries';
import { makeUser, truncateAll } from '../helpers/db';

const PAGE: PageParams = { page: 1, pageSize: DEFAULT_PAGE_SIZE, offset: 0 };

const A = 'ICCS427343';
const B = 'C2CM24850';
/** Owns leads, absent from the roster — spec 6.4 keeps the leads and flags the code. */
const ORPHAN = 'ICCS888111';
/** The workbook's literal "nobody owns this yet" value. Not a rep. */
const SENTINEL = '111222-UN';

function session(row: {
  id: string;
  email: string;
  name: string;
  role: Role;
  smId: string | null;
  isActive: boolean;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    smId: row.smId,
    isActive: row.isActive,
  };
}

function filters(over: Partial<LeadFilters> = {}): LeadFilters {
  return { ...EMPTY_LEAD_FILTERS, ...over };
}

let salesA: SessionUser;
let salesB: SessionUser;
let salesOrphan: SessionUser;
let admin: SessionUser;
let approver: SessionUser;

beforeEach(async () => {
  await truncateAll();

  admin = session(await makeUser({ role: 'admin', smId: null, email: 'admin@example.test' }));
  approver = session(
    await makeUser({ role: 'approver', smId: null, email: 'approver@example.test' }),
  );
  salesA = session(await makeUser({ role: 'sales', smId: A, email: 'a@example.test' }));
  salesB = session(await makeUser({ role: 'sales', smId: B, email: 'b@example.test' }));
  salesOrphan = session(
    await makeUser({ role: 'sales', smId: ORPHAN, email: 'orphan@example.test' }),
  );

  // Only A and B are on the roster. ORPHAN's absence is what makes it an orphan.
  await db.insert(manpower).values([
    { smId: A, smName: 'Aarti Rep' },
    { smId: B, smName: 'Bharat Rep' },
  ]);

  await db.insert(lead).values([
    {
      leadNo: 'LEAD-A-1',
      smCode: A,
      smName: 'Aarti Rep',
      tlName: 'Tara TL',
      location: 'Pune',
      registerDate: '2026-06-01',
      source: 'DIGITAL',
    },
    {
      leadNo: 'LEAD-A-2',
      smCode: A,
      smName: 'Aarti Rep',
      location: 'Nashik',
      registerDate: '2026-06-10',
    },
    {
      leadNo: 'LEAD-A-3',
      smCode: A,
      smName: 'Aarti Rep',
      location: 'Pune',
      registerDate: '2026-06-20',
    },
    {
      leadNo: 'LEAD-B-1',
      smCode: B,
      smName: 'Bharat Rep',
      location: 'Indore',
      locationAlt: 'Ujjain',
      registerDate: '2026-06-04',
    },
    {
      leadNo: 'LEAD-B-2',
      smCode: B,
      smName: 'Bharat Rep',
      location: 'Indore',
      registerDate: '2026-06-15',
    },
    {
      leadNo: 'LEAD-O-1',
      smCode: ORPHAN,
      smName: 'Omkar Rep',
      location: 'Surat',
      registerDate: '2026-06-08',
    },
    {
      leadNo: 'LEAD-U-1',
      smCode: SENTINEL,
      smName: 'Unallocated',
      location: 'Pune',
      registerDate: '2026-06-02',
      isUnassigned: true,
    },
    {
      leadNo: 'LEAD-U-2',
      smCode: SENTINEL,
      smName: 'Unallocated',
      location: 'Indore',
      registerDate: '2026-06-18',
      isUnassigned: true,
    },
  ]);
});

async function leadNosFor(viewer: SessionUser, f: LeadFilters = filters()) {
  const { rows } = await listLeads(viewer, f, PAGE);
  return rows.map((r) => r.leadNo).sort();
}

describe('the list query is scoped to the session, not to a parameter', () => {
  it('gives a sales user only their own SM code', async () => {
    expect(await leadNosFor(salesA)).toEqual(['LEAD-A-1', 'LEAD-A-2', 'LEAD-A-3']);
    expect(await leadNosFor(salesB)).toEqual(['LEAD-B-1', 'LEAD-B-2']);
  });

  it('scopes the total count as well as the page', async () => {
    // A count built from a different predicate than the rows is how a UI ends
    // up announcing "8 leads" over a list of 3.
    expect(await countLeads(salesA, filters())).toBe(3);
    expect(await countLeads(salesB, filters())).toBe(2);
    expect(await countLeads(admin, filters())).toBe(8);
  });

  it('shows an admin and an approver everything', async () => {
    expect(await leadNosFor(admin)).toHaveLength(8);
    expect(await leadNosFor(approver)).toHaveLength(8);
  });

  it('still gives a rep their leads when their code is off the roster', async () => {
    // Spec 6.4: the roster being stale is the roster's problem. Dropping the row
    // would hide a real lead from a real person to tidy a spreadsheet.
    expect(await leadNosFor(salesOrphan)).toEqual(['LEAD-O-1']);
  });
});

describe('the unassigned pool belongs to the admin, never to a rep', () => {
  it('keeps the pool out of every rep list', async () => {
    for (const rep of [salesA, salesB, salesOrphan]) {
      const nos = await leadNosFor(rep);
      expect(nos).not.toContain('LEAD-U-1');
      expect(nos).not.toContain('LEAD-U-2');
    }
  });

  it('refuses to hand a rep the pool through the ownership filter', async () => {
    // The scope ANDs `is_unassigned = false`, so asking for the pool narrows a
    // rep to nothing rather than widening them into it.
    expect(await leadNosFor(salesA, filters({ ownership: 'UNASSIGNED' }))).toEqual([]);
  });

  it('refuses to hand a rep the pool through the sentinel code', async () => {
    expect(await leadNosFor(salesA, filters({ smCode: SENTINEL }))).toEqual([]);
  });

  it('gives the admin the pool as its own view', async () => {
    expect(await leadNosFor(admin, filters({ ownership: 'UNASSIGNED' }))).toEqual([
      'LEAD-U-1',
      'LEAD-U-2',
    ]);
    expect(await leadNosFor(admin, filters({ ownership: 'ASSIGNED' }))).toHaveLength(6);
  });
});

describe('no filter parameter can widen a sales user scope', () => {
  it('ignores ?smCode= at the parse layer', async () => {
    const parsed = parseLeadFilters({ smCode: B }, salesA);
    expect(parsed.smCode).toBeNull();
    expect(await leadNosFor(salesA, parsed)).toHaveLength(3);
  });

  it('still refuses when the SM code filter is forced past the parser', async () => {
    // Simulates a refactor that stops stripping smCode for sales users. The
    // scoped predicate is ANDed, so the worst outcome is an empty list — never
    // another rep's leads.
    expect(await leadNosFor(salesA, filters({ smCode: B }))).toEqual([]);
  });

  it('does not leak another rep through a search term', async () => {
    expect(await leadNosFor(salesA, filters({ q: 'Bharat Rep' }))).toEqual([]);
    expect(await leadNosFor(salesA, filters({ q: 'LEAD-B-1' }))).toEqual([]);
    expect(await leadNosFor(salesA, filters({ q: 'Indore' }))).toEqual([]);
    // The same term run as an admin proves the rows exist and the term matches —
    // otherwise the three assertions above would pass on a broken search.
    expect(await leadNosFor(admin, filters({ q: 'Indore' }))).toEqual([
      'LEAD-B-1',
      'LEAD-B-2',
      'LEAD-U-2',
    ]);
  });

  it('does not leak another rep through the second location column', async () => {
    // `location_alt` is searched too, so it is one more column that has to stay
    // inside the scope rather than beside it.
    expect(await leadNosFor(salesA, filters({ q: 'Ujjain' }))).toEqual([]);
    expect(await leadNosFor(admin, filters({ q: 'Ujjain' }))).toEqual(['LEAD-B-1']);
  });

  it('does not leak another rep through the register-date range', async () => {
    expect(await leadNosFor(salesA, filters({ registerFrom: '2026-06-01', registerTo: '2026-06-30' })))
      .toEqual(['LEAD-A-1', 'LEAD-A-2', 'LEAD-A-3']);
    expect(await leadNosFor(salesA, filters({ registerFrom: '2026-06-04', registerTo: '2026-06-04' })))
      .toEqual([]);
    expect(await leadNosFor(admin, filters({ registerFrom: '2026-06-04', registerTo: '2026-06-04' })))
      .toEqual(['LEAD-B-1']);
  });

  it('does not let a hand-edited ownership value degrade into no filter', async () => {
    // A junk value falls back to ALL, which for a rep is still their own scope.
    const parsed = parseLeadFilters({ ownership: 'EVERYTHING' }, salesA);
    expect(parsed.ownership).toBe('ALL');
    expect(await leadNosFor(salesA, parsed)).toHaveLength(3);
  });
});

describe('the summary counters are scoped the same way the list is', () => {
  it('confines a rep to their own book', async () => {
    // total === mine and reps === 1 is the assertion: a rep's dashboard must not
    // be able to report the size of the whole file, let alone how many other
    // reps are in it.
    expect(await leadSummary(salesA)).toEqual({
      total: 3,
      mine: 3,
      unassigned: 0,
      reps: 1,
      orphanCodes: 0,
    });
    expect(await leadSummary(salesB)).toEqual({
      total: 2,
      mine: 2,
      unassigned: 0,
      reps: 1,
      orphanCodes: 0,
    });
  });

  it('tells an off-roster rep nothing about their own orphan status through the pool', async () => {
    expect(await leadSummary(salesOrphan)).toEqual({
      total: 1,
      mine: 1,
      unassigned: 0,
      reps: 1,
      orphanCodes: 1,
    });
  });

  it('gives the admin the whole picture', async () => {
    expect(await leadSummary(admin)).toEqual({
      total: 8,
      // An admin has no SM code, so "mine" is not a question they can ask.
      mine: 0,
      unassigned: 2,
      // A, B and ORPHAN. The sentinel is not a rep and must not be counted as one.
      reps: 3,
      orphanCodes: 1,
    });
  });
});

describe('the orphan list is the admin reconcile list', () => {
  it('names the code, its lead count and the name the sheet carried', async () => {
    const rows = await listOrphanCodes(admin);
    expect(rows).toEqual([
      { smCode: ORPHAN, smName: 'Omkar Rep', leads: 1, latestRegisterDate: '2026-06-08' },
    ]);
  });

  it('is empty for everyone else', async () => {
    // Not a scope leak — the codes own no data a rep could read — but the roster
    // of other reps' codes is information they have no reason to hold.
    expect(await listOrphanCodes(salesA)).toEqual([]);
    expect(await listOrphanCodes(salesOrphan)).toEqual([]);
    expect(await listOrphanCodes(approver)).toEqual([]);
  });
});

describe('a sales session with no SM_ID fails closed', () => {
  const unscopable: SessionUser = {
    id: 'ghost',
    email: 'ghost@example.test',
    name: 'Ghost',
    role: 'sales',
    smId: null,
    isActive: true,
  };

  it('throws rather than running an unfiltered query', async () => {
    // "No condition" means "no filter", so a fall-through here would show one
    // misconfigured rep every rep's leads. A database CHECK makes the account
    // impossible to create; this is the belt to that braces.
    await expect(listLeads(unscopable, filters(), PAGE)).rejects.toBeInstanceOf(AuthzError);
    await expect(countLeads(unscopable, filters())).rejects.toBeInstanceOf(AuthzError);
    await expect(leadSummary(unscopable)).rejects.toBeInstanceOf(AuthzError);
  });
});
