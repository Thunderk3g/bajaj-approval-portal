/**
 * How a flat Manpower sheet becomes three rungs.
 *
 * Every fixture below is a shape the July'26 workbook actually contains, because
 * every one of them broke something when the worklist read the sheet as a flat
 * list of reps:
 *
 *   * `112224 Sagar Chavan` — an area manager with a row of his own, offered as
 *     a rep to give a Sales login to.
 *   * `503576 Shantanu singh` — an area manager with NO row of his own, who
 *     therefore appeared nowhere at all and could never be provisioned.
 *   * `300N000001 JIBL` — a self-referential row that names nobody but itself,
 *     which grew a one-person team on /admin/hierarchy.
 *   * `DIY` — same shape, and a bucket for unclaimed business rather than a
 *     person.
 *
 * Pure, so none of it needs a database.
 */

import { describe, expect, it } from 'vitest';
import { buildRoster, rosterKey, type RosterSheetRow } from '@/lib/roster/entries';

function row(over: Partial<RosterSheetRow> & { smId: string }): RosterSheetRow {
  return {
    smName: null,
    location: null,
    isOrphan: false,
    tlId: null,
    ccmId: null,
    sheetTlId: over.tlId ?? null,
    tlName: null,
    sheetCcmId: over.ccmId ?? null,
    ccmName: null,
    ...over,
  };
}

/** Two reps under TL001, whose ACM is ACM001. TL001 has a row; ACM001 does not. */
const TEAM = [
  row({ smId: 'REP001', smName: 'Ravi Kumar', location: 'Pune', tlId: 'TL001', ccmId: 'ACM001' }),
  row({ smId: 'REP002', smName: 'Asha Rao', location: 'Pune', tlId: 'TL001', ccmId: 'ACM001' }),
  row({ smId: 'TL001', smName: 'Sunil P', location: 'Pune', tlId: 'TL001', ccmId: 'ACM001' }),
];

describe('buildRoster', () => {
  it('puts a manager on their own rung instead of listing them as a rep', () => {
    const entries = buildRoster(TEAM);

    // TL001 has a manpower row like any rep. It must NOT produce a sales entry —
    // that is the login that used to be offered for an area manager.
    expect(entries.map(rosterKey)).toEqual([
      'acm:ACM001',
      'tl:TL001',
      'sales:REP001',
      'sales:REP002',
    ]);

    const tl = entries.find((e) => e.rung === 'tl')!;
    // Two reports, not three: their own row is not one of their reports.
    expect(tl.reports).toBe(2);
    expect(tl.name).toBe('Sunil P');
    expect(tl.parentCode).toBe('ACM001');
  });

  it('finds a manager who has no row of their own', () => {
    const acm = buildRoster(TEAM).find((e) => e.code === 'ACM001')!;

    // ACM001 exists only as a code in the CCM_ID column, as `503576` does in the
    // real sheet. The name has to come off the reps' rows or the entry is
    // unrecognisable.
    expect(acm.rung).toBe('acm');
    expect(acm.reports).toBe(3);
    expect(acm.parentCode).toBeNull();
  });

  it('names the team from a rep the sheet itself places there, not an overridden one', () => {
    const moved = row({
      smId: 'REP003',
      smName: 'Moved Rep',
      // An admin dragged them onto TL001; the sheet still says TL999, and
      // `tlName` describes TL999's manager.
      tlId: 'TL001',
      ccmId: 'ACM001',
      sheetTlId: 'TL999',
      tlName: 'Somebody Else',
    });

    const tl = buildRoster([moved, ...TEAM]).find((e) => e.code === 'TL001')!;
    expect(tl.name).toBe('Sunil P');
    expect(tl.reports).toBe(3);
  });

  it('gives one entry, at the highest rung, to a person the sheet names twice', () => {
    // Exactly `112224 Sagar Chavan`: area manager of the cluster, and team leader
    // of one team inside it because those reps have no team leader of their own.
    // That is one man with one job title, not two people — so one entry, at the
    // higher rung, and one login. Two entries meant two accounts and one person
    // appearing twice on every people screen.
    const entries = buildRoster([
      row({ smId: 'BOTH01', smName: 'Sagar Chavan', tlId: 'BOTH01', ccmId: 'BOTH01' }),
      row({ smId: 'REP001', tlId: 'BOTH01', ccmId: 'BOTH01' }),
      row({ smId: 'REP002', tlId: 'TL001', ccmId: 'BOTH01' }),
      row({ smId: 'TL001', tlId: 'TL001', ccmId: 'BOTH01' }),
    ]);

    const held = entries.filter((e) => e.code === 'BOTH01');
    expect(held.map(rosterKey)).toEqual(['acm:BOTH01']);
    // The cluster count, which already contains the team he leads directly.
    expect(held[0].reports).toBe(3);
    // Recorded rather than dropped: the screen can still say he leads a team.
    expect(held[0].alsoRungs).toEqual(['tl']);
    // And no sales entry, which is what the old flat read produced.
    expect(entries.some((e) => rosterKey(e) === 'sales:BOTH01')).toBe(false);
  });

  it('keeps a plain team leader on the tl rung', () => {
    // The collapse must not promote: TL001 heads no cluster, so nothing about
    // BOTH01 above may leak into an entry for him.
    const entries = buildRoster([
      row({ smId: 'REP002', tlId: 'TL001', ccmId: 'BOTH01' }),
      row({ smId: 'TL001', tlId: 'TL001', ccmId: 'BOTH01' }),
    ]);

    const tl = entries.find((e) => e.code === 'TL001')!;
    expect(tl.rung).toBe('tl');
    expect(tl.alsoRungs).toEqual([]);
    expect(tl.parentCode).toBe('BOTH01');
  });

  it('does not turn a row that names only itself into a team', () => {
    // `300N000001 JIBL` — a channel, not a manager. Nobody reports to it, so it
    // is no rung at all; it falls through to the rep branch where an admin can
    // see it and strike it off.
    const entries = buildRoster([
      row({ smId: 'JIBL01', smName: 'JIBL', tlId: 'JIBL01', ccmId: 'JIBL01' }),
    ]);

    expect(entries.map(rosterKey)).toEqual(['sales:JIBL01']);
    expect(entries[0].reports).toBe(0);
  });

  it('leaves the sheet’s buckets out entirely, at every rung', () => {
    const entries = buildRoster([
      row({ smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' }),
      row({ smId: '111222-UN', smName: 'DIY', tlId: '111222-UN', ccmId: '111222-UN' }),
      // A real rep the sheet parks under the bucket. They are still a person, but
      // the bucket above them is not a manager anybody can provision.
      row({ smId: 'REP009', tlId: 'DIY', ccmId: 'DIY' }),
      ...TEAM,
    ]);

    expect(entries.some((e) => e.code === 'DIY' || e.code === '111222-UN')).toBe(false);
    expect(entries.some((e) => rosterKey(e) === 'sales:REP009')).toBe(true);
  });

  it('leaves out reps the sheet places under nobody', () => {
    const entries = buildRoster([
      row({ smId: 'UNPLACED', smName: 'No Team' }),
      row({ smId: 'ORPHAN01', smName: 'Off Sheet', tlId: 'TL001', ccmId: 'ACM001', isOrphan: true }),
      ...TEAM,
    ]);

    // Neither can be given an account — every approval step would resolve to
    // nobody — so both belong on /admin/hierarchy, not here.
    expect(entries.some((e) => e.code === 'UNPLACED')).toBe(false);
    expect(entries.some((e) => e.code === 'ORPHAN01')).toBe(false);
  });
});
