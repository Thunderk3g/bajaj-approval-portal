/**
 * One upload's policies laid over the Manpower hierarchy — area manager → team
 * leader → rep, with the policy count that landed on each.
 *
 * The two sheets in a workbook answer different questions and this is where they
 * meet. Manpower says who exists and who they report to; the login dump says
 * what was sold and by whom. An admin looking at a committed batch wants the
 * join: did this month's business land where the org chart says it should, and
 * how much of it landed nowhere.
 *
 * "Nowhere" is the point of the third bucket. `sales_record.sm_id` is not a list
 * of people — it carries `DIY` for digital-channel business and `111222-UN` for
 * issuance nobody has claimed, plus whatever codes the dump names that the
 * roster has never heard of. Those policies are real and they are counted; they
 * are simply not attributable to a person, and a chart that folded them into a
 * team would be claiming a rep sold them.
 *
 * The hierarchy is the effective one — the roster with any admin override
 * applied, the same `coalesce` precedence `resolveHierarchy` and the tree use.
 * A rep moved to another team must count towards the team they are actually on.
 */

import { count, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, manpowerOverride, salesRecord } from '@/db/schema';
import { isPlaceholderCode } from '@/lib/roster/placeholders';

export type CoverageRep = {
  smId: string;
  smName: string | null;
  policies: number;
};

export type CoverageTeam = {
  /** Null when the roster places this rep under no team leader. */
  tlId: string | null;
  tlName: string | null;
  reps: CoverageRep[];
  policies: number;
};

export type CoverageGroup = {
  /** Null when the roster places this team under no area manager. */
  acmId: string | null;
  acmName: string | null;
  teams: CoverageTeam[];
  policies: number;
};

export type CoverageOrphan = {
  smId: string;
  policies: number;
  /** True for `DIY` / `111222-UN` — on the sheet, but a bucket rather than a person. */
  placeholder: boolean;
};

export type BatchCoverage = {
  groups: CoverageGroup[];
  /** Codes in the dump that no person can be held to, biggest first. */
  orphans: CoverageOrphan[];
  totals: {
    policies: number;
    /** Policies that reached a rep the roster knows. */
    attributed: number;
    unattributed: number;
    acms: number;
    tls: number;
    reps: number;
  };
};

/**
 * The whole fan-out for one committed batch.
 *
 * One grouped query and a folding pass, not a query per rung: the roster is a
 * few hundred rows and the dump groups down to one row per code, so the entire
 * chart costs a single round trip. Grouping in SQL rather than fetching the
 * batch's rows matters more here than elsewhere — a month's upload is tens of
 * thousands of rows and this page would otherwise carry all of them into
 * JavaScript to produce about 230 numbers.
 */
export async function loadBatchCoverage(batchId: string): Promise<BatchCoverage> {
  const rows = await db
    .select({
      smId: salesRecord.smId,
      policies: count(),
      // Null when the dump names a code the roster has no row for at all. Read
      // off `manpower` rather than the record's own `sm_name`/`tl_id` columns:
      // those are a snapshot of what the sheet said on import day, and the
      // hierarchy this chart draws has to be the current one.
      rosterCode: manpower.smId,
      smName: manpower.smName,
      tlName: manpower.tlName,
      ccmName: manpower.ccmName,
      overrideTlId: manpowerOverride.tlId,
      overrideCcmId: manpowerOverride.ccmId,
      effectiveTlId: sql<string | null>`coalesce(${manpowerOverride.tlId}, ${manpower.tlId})`,
      effectiveCcmId: sql<string | null>`coalesce(${manpowerOverride.ccmId}, ${manpower.ccmId})`,
    })
    .from(salesRecord)
    .leftJoin(manpower, eq(manpower.smId, salesRecord.smId))
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, salesRecord.smId))
    .where(eq(salesRecord.sourceBatchId, batchId))
    .groupBy(
      salesRecord.smId,
      manpower.smId,
      manpower.smName,
      manpower.tlId,
      manpower.tlName,
      manpower.ccmId,
      manpower.ccmName,
      manpowerOverride.tlId,
      manpowerOverride.ccmId,
    );

  const groups = new Map<string, CoverageGroup>();
  const teamsByGroup = new Map<string, Map<string, CoverageTeam>>();
  const orphans: CoverageOrphan[] = [];

  let policies = 0;
  let attributed = 0;
  let reps = 0;

  for (const row of rows) {
    policies += row.policies;

    // Placeholder first: the sheet carries a row for both buckets, so asking
    // the roster whether they exist answers yes and would file the digital
    // channel under a team leader named `DIY`.
    if (isPlaceholderCode(row.smId) || !row.rosterCode) {
      orphans.push({
        smId: row.smId,
        policies: row.policies,
        placeholder: isPlaceholderCode(row.smId),
      });
      continue;
    }

    attributed += row.policies;
    reps += 1;

    // '' is the key for "the roster places them under nobody". A real code can
    // never collide with it: `sm_id` is NOT NULL and the uppercase CHECK on the
    // column rejects an empty string.
    const acmId = row.effectiveCcmId;
    const groupKey = acmId ?? '';
    // A name is only the sheet's to give when no override has moved the rep —
    // otherwise it is the name of the manager they used to report to.
    const acmName = row.overrideCcmId ? null : row.ccmName;

    let group = groups.get(groupKey);
    if (!group) {
      group = { acmId, acmName, teams: [], policies: 0 };
      groups.set(groupKey, group);
      teamsByGroup.set(groupKey, new Map());
    }
    if (!group.acmName && acmName) group.acmName = acmName;
    group.policies += row.policies;

    const tlId = row.effectiveTlId;
    const teamKey = tlId ?? '';
    const teams = teamsByGroup.get(groupKey)!;

    let team = teams.get(teamKey);
    if (!team) {
      team = { tlId, tlName: row.overrideTlId ? null : row.tlName, reps: [], policies: 0 };
      teams.set(teamKey, team);
      group.teams.push(team);
    }
    if (!team.tlName && !row.overrideTlId && row.tlName) team.tlName = row.tlName;
    team.policies += row.policies;
    team.reps.push({ smId: row.smId, smName: row.smName, policies: row.policies });
  }

  // Biggest first, everywhere. The chart is read for where the volume is, and
  // an alphabetical ordering buries the one team that carried the month.
  const byPolicies = <T extends { policies: number }>(a: T, b: T) => b.policies - a.policies;

  const ordered = [...groups.values()].sort(byPolicies);
  for (const group of ordered) {
    group.teams.sort(byPolicies);
    for (const team of group.teams) team.reps.sort(byPolicies);
  }
  orphans.sort(byPolicies);

  return {
    groups: ordered,
    orphans,
    totals: {
      policies,
      attributed,
      unattributed: policies - attributed,
      acms: ordered.length,
      tls: ordered.reduce((n, g) => n + g.teams.length, 0),
      reps,
    },
  };
}
