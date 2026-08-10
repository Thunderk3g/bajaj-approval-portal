import { isPlaceholderCode } from './placeholders';

/**
 * Everybody the Manpower sheet names, at the rung the sheet puts them on.
 *
 * The sheet is the ONLY source. Nothing here reads `lead`, `sales_record` or any
 * other imported transaction data: those files say which codes did business, not
 * who the people are, and deriving staff from them is how the portal ended up
 * offering logins to codes like `DIY` that were never a person.
 *
 * The sheet has no separate manager table. A manager exists as a CODE in the
 * `TL_ID` / `CCM_ID` column of the reps beneath them, and USUALLY — not always —
 * also carries a row of their own where `SM_ID = TL_ID`. Both forms occur in the
 * July workbook: `112224` has its own row, `503576` does not and exists purely as
 * the CCM of three other reps. So the rungs are derived from the code columns,
 * with the self-row used only for the person's name and location when it exists.
 *
 * That derivation is the whole point. Reading `manpower` as a flat list of reps —
 * which is what the provisioning worklist used to do — offers `112224 Sagar
 * Chavan` as a rep to give a Sales login to, when the sheet plainly says he is an
 * area manager over 41 people.
 *
 * Deliberately free of database imports. `RUNG_LABELS` and the types are read by
 * the worklist's client component, and a module that reached `@/db/client` would
 * drag the connection pool into the browser bundle. The one query that feeds
 * `buildRoster` lives in src/lib/users/queries.ts beside its only caller.
 */

export type RosterRung = 'sales' | 'tl' | 'acm';

/** The rung IS the account role; they are the same three strings on purpose. */
export const RUNG_LABELS: Record<RosterRung, string> = {
  sales: 'Sales manager',
  tl: 'Team leader',
  acm: 'Area manager',
};

export type RosterEntry = {
  code: string;
  name: string | null;
  rung: RosterRung;
  location: string | null;
  /** The TL a rep sits under, the ACM a TL sits under; null for an ACM. */
  parentCode: string | null;
  /**
   * People beneath this code, NOT counting its own row.
   *
   * Excluding self is what makes zero mean "nobody depends on this entry", which
   * is the test the roster-delete action gates on. A manager code that names only
   * itself — `300N000001 JIBL` in the July sheet — is a channel bucket wearing a
   * person's shape, and counting its own row would make it look like a team.
   *
   * For a code that holds more than one rung this is the count at `rung`, the
   * highest one — and the highest rung's span contains the lower one's, since
   * every rep who names this code as their team leader also sits in the cluster
   * it heads.
   */
  reports: number;
  /**
   * The lower rungs this same code also occupies on the sheet, if any.
   *
   * Carried so a screen can say WHY one row stands for two jobs. It is display
   * only: the account, the role and the scoping column all follow `rung`.
   */
  alsoRungs: RosterRung[];
};

export const EMAIL_DOMAIN = 'bajajlife.com';

/**
 * The sign-in address a provisioned account for this entry gets.
 *
 * Derived from the code and the rung, never from the name: the code is the only
 * stable identifier in this data, and derivation is the whole of the idempotency
 * story — the same entry always resolves to the same address, so a second pass
 * recognises the account the first one made. The rung prefix carries no meaning
 * beyond readability now that a code yields exactly one entry: `buildRoster`
 * collapses a multi-rung code to its highest rung, so there is no second address
 * for the same person to collide with.
 */
export function emailForRosterEntry(rung: RosterRung, code: string): string {
  const prefix = rung === 'sales' ? 'sm' : rung;
  return `${prefix}.${code.toLowerCase()}@${EMAIL_DOMAIN}`;
}

/** Stable identifier for one worklist row — one code, one person, one rung. */
export function rosterKey(entry: { rung: RosterRung; code: string }): string {
  return `${entry.rung}:${entry.code}`;
}

export type RosterSheetRow = {
  smId: string;
  smName: string | null;
  location: string | null;
  isOrphan: boolean;
  /** After any admin override — the line that actually routes approvals. */
  tlId: string | null;
  ccmId: string | null;
  /** The sheet's own line, before overrides, so team NAMES stay attributable. */
  sheetTlId: string | null;
  tlName: string | null;
  sheetCcmId: string | null;
  ccmName: string | null;
};

type Aggregate = { name: string | null; location: string | null; reports: number; parent: string | null };

/**
 * Pure so it can be tested against a handful of literal rows.
 *
 * The interesting cases in this function are all shapes the real workbook
 * contains — a manager with no row of their own, a manager who is also somebody
 * else's rep, a code that holds two rungs at once — and none of them need a
 * database to demonstrate.
 */
export function buildRoster(rows: RosterSheetRow[]): RosterEntry[] {
  const ownRow = new Map(rows.map((row) => [row.smId, row]));

  const tls = new Map<string, Aggregate>();
  const acms = new Map<string, Aggregate>();

  const fold = (
    into: Map<string, Aggregate>,
    code: string | null,
    row: RosterSheetRow,
    sheetCode: string | null,
    sheetName: string | null,
    parent: string | null,
  ) => {
    if (!code || isPlaceholderCode(code)) return;

    const agg = into.get(code) ?? { name: null, location: null, reports: 0, parent: null };

    // Their own row is not one of their reports; see the note on `reports`.
    if (row.smId !== code) agg.reports += 1;

    // The name comes from a rep the SHEET places here. A rep an override moved
    // in carries their previous manager's name in `tl_name`, and using it would
    // label this team with somebody else's manager.
    if (!agg.name && sheetCode === code) agg.name = sheetName;
    if (!agg.location) agg.location = row.location;
    if (!agg.parent && parent && !isPlaceholderCode(parent)) agg.parent = parent;

    into.set(code, agg);
  };

  for (const row of rows) {
    if (isPlaceholderCode(row.smId)) continue;
    fold(tls, row.tlId, row, row.sheetTlId, row.tlName, row.ccmId);
    fold(acms, row.ccmId, row, row.sheetCcmId, row.ccmName, null);
  }

  /**
   * A code is a manager only if somebody OTHER than itself reports to it.
   *
   * Without this, every self-referential row in the sheet becomes a one-person
   * team and a one-person cluster — which is exactly how `DIY` grew a team on
   * /admin/hierarchy. A code that names nobody but itself is not a rung; it falls
   * through to the rep branch below, where an admin can see it and delete it.
   */
  const isManager = (map: Map<string, Aggregate>, code: string) => (map.get(code)?.reports ?? 0) > 0;

  const nameFor = (code: string, fallback: string | null) => ownRow.get(code)?.smName ?? fallback;
  const locationFor = (code: string, fallback: string | null) =>
    ownRow.get(code)?.location ?? fallback;

  const entries: RosterEntry[] = [];

  /**
   * A code that leads a team AND heads a cluster is ONE person, at their highest
   * rung.
   *
   * `112224 Sagar Chavan` is the area manager of 41 people and the team leader of
   * 8 of them — not because he holds two jobs, but because those 8 reps have no
   * team leader of their own and the sheet fills the column with his code. This
   * used to emit two entries and provision two logins, `acm.112224@…` and
   * `tl.112224@…`, so one man appeared twice on every people screen and could be
   * asked to approve as two different identities.
   *
   * One entry now, at the highest rung. What made the two-account shape necessary
   * was `resolveApprover`, which matched a stage's rung against its own column —
   * so an ACM account could not answer a TL step. That match is by CODE now (see
   * src/lib/hierarchy/queries.ts), so his single account answers both rungs for
   * the reps whose sheet line names him.
   *
   * `checkScopeAgainstRole` still allows exactly one scoping code per account,
   * and that stays true: the account is an ACM carrying `acm_code`, nothing else.
   */
  for (const code of new Set([...acms.keys(), ...tls.keys()])) {
    const asAcm = acms.get(code);
    const asTl = tls.get(code);
    const leadsCluster = (asAcm?.reports ?? 0) > 0;
    const leadsTeam = (asTl?.reports ?? 0) > 0;
    if (!leadsCluster && !leadsTeam) continue;

    const agg = (leadsCluster ? asAcm : asTl)!;
    entries.push({
      code,
      name: nameFor(code, agg.name),
      rung: leadsCluster ? 'acm' : 'tl',
      location: locationFor(code, agg.location),
      parentCode: leadsCluster ? null : agg.parent,
      reports: agg.reports,
      alsoRungs: leadsCluster && leadsTeam ? ['tl'] : [],
    });
  }

  for (const row of rows) {
    if (isPlaceholderCode(row.smId)) continue;
    if (isManager(tls, row.smId) || isManager(acms, row.smId)) continue;

    // A rep the sheet places under nobody cannot be given an account — every
    // approval step would resolve to nobody — so they are left to
    // /admin/hierarchy, which exists to name exactly that gap.
    if (row.isOrphan || !row.tlId) continue;

    entries.push({
      code: row.smId,
      name: row.smName,
      rung: 'sales',
      location: row.location,
      parentCode: row.tlId,
      reports: 0,
      alsoRungs: [],
    });
  }

  return entries.sort(byRungThenCode);
}

const RUNG_ORDER: Record<RosterRung, number> = { acm: 0, tl: 1, sales: 2 };

export function byRungThenCode(a: RosterEntry, b: RosterEntry): number {
  const rung = RUNG_ORDER[a.rung] - RUNG_ORDER[b.rung];
  return rung !== 0 ? rung : a.code.localeCompare(b.code);
}
