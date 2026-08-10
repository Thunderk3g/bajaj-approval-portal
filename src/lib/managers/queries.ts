import { and, count, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, manpower, manpowerOverride, salesRecord, user } from '@/db/schema';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';
import type { SessionUser } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';

/**
 * What a team leader or an area manager sees — 2026-08-06 spec section 5.
 *
 * One module for both because the two roles differ only in which column places a
 * rep beneath them: a TL owns the reps whose effective `tl_id` is their code, an
 * ACM owns the reps whose effective `ccm_id` is theirs. Everything after that —
 * the queue, the team list, the counts — is the same question asked of a
 * different set of SM_IDs, and writing it twice would be two chances to scope one
 * of them wrongly.
 *
 * "Effective" throughout means the roster with any admin override applied, the
 * same precedence `resolveHierarchy` uses. A manager must see the reps they are
 * actually answerable for, not the ones a stale sheet says they are.
 */

/** The code that scopes this manager, or a refusal if their account carries none. */
export function managerScope(actor: SessionUser): { column: 'tl_id' | 'ccm_id'; code: string } {
  if (actor.role === 'tl') {
    if (!actor.tlCode) throw new AuthzError('FORBIDDEN', 'This team leader account has no TL code.');
    return { column: 'tl_id', code: actor.tlCode };
  }
  if (actor.role === 'acm') {
    if (!actor.acmCode) throw new AuthzError('FORBIDDEN', 'This area manager account has no ACM code.');
    return { column: 'ccm_id', code: actor.acmCode };
  }
  throw new AuthzError('FORBIDDEN', 'Only a team leader or an area manager has a team.');
}

export type TeamMember = {
  smId: string;
  smName: string | null;
  location: string | null;
  /** Null for an ACM's view of a rep whose TL the roster does not record. */
  tlId: string | null;
  recordCount: number;
  openRequests: number;
  hasAccount: boolean;
};

export async function listTeam(actor: SessionUser): Promise<TeamMember[]> {
  const scope = managerScope(actor);

  const members = await db
    .select({
      smId: manpower.smId,
      smName: manpower.smName,
      location: manpower.location,
      tlId: sql<string | null>`coalesce(${manpowerOverride.tlId}, ${manpower.tlId})`,
    })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(
      and(
        scope.column === 'tl_id'
          ? sql`coalesce(${manpowerOverride.tlId}, ${manpower.tlId}) = ${scope.code}`
          : sql`coalesce(${manpowerOverride.ccmId}, ${manpower.ccmId}) = ${scope.code}`,
        // The sheet's bucket rows name themselves at all three rungs, so `DIY`
        // sits under `DIY` and would join any manager whose code it matched.
        // A team list is a list of people; the digital channel is not one of
        // them, and it is not somebody this manager can be asked about.
        notInArray(manpower.smId, PLACEHOLDER_CODE_LIST),
      ),
    )
    .orderBy(manpower.smId);

  if (members.length === 0) return [];

  const ids = members.map((m) => m.smId);

  // Three small aggregates rather than one join with two counts: a rep with no
  // records and a rep with no requests are both absent from their respective
  // grouping, and a single query would drop them from the team list entirely.
  //
  // `inArray`, never `sql\`col = any(${ids})\``. Drizzle's template tag expands a
  // JS array into a comma-separated parameter TUPLE — `any(($1, $2, $3))` — and
  // Postgres refuses that with `op ANY/ALL (array) requires array on right side`.
  // It parses, so it survives review; it fails at runtime the moment a manager
  // with a team opens their own screen, which is every time this page is used
  // for its purpose. Same trap as the note in src/lib/periods/service.ts.
  const [records, open, accounts] = await Promise.all([
    db
      .select({ smId: salesRecord.smId, value: count() })
      .from(salesRecord)
      .where(inArray(salesRecord.smId, ids))
      .groupBy(salesRecord.smId),
    db
      .select({ smId: correctionRequest.smId, value: count() })
      .from(correctionRequest)
      .where(
        and(
          inArray(correctionRequest.smId, ids),
          sql`${correctionRequest.status} in ('PENDING','VERIFIED','RETURNED')`,
        ),
      )
      .groupBy(correctionRequest.smId),
    db
      .select({ smId: user.smId })
      .from(user)
      .where(and(inArray(user.smId, ids), eq(user.isActive, true))),
  ]);

  const recordBy = new Map(records.map((r) => [r.smId, r.value]));
  const openBy = new Map(open.map((r) => [r.smId, r.value]));
  const withAccount = new Set(accounts.map((r) => r.smId));

  return members.map((m) => ({
    smId: m.smId,
    smName: m.smName,
    location: m.location,
    tlId: m.tlId,
    recordCount: recordBy.get(m.smId) ?? 0,
    openRequests: openBy.get(m.smId) ?? 0,
    hasAccount: withAccount.has(m.smId),
  }));
}

export type ManagerSummary = {
  teamSize: number;
  waitingOnMe: number;
  openInTeam: number;
  repsWithoutAccounts: number;
};

export async function managerSummary(actor: SessionUser): Promise<ManagerSummary> {
  const [team, waiting] = await Promise.all([
    listTeam(actor),
    // Counted through the stage table rather than by re-resolving the hierarchy:
    // a rung records who it resolved to when it opened, so "waiting on me" is the
    // same indexed question the queue asks.
    db.execute<{ count: number }>(sql`
      select count(*)::int as count
        from correction_request_stage s
       where s.status = 'ACTIVE'
         and s.assigned_user_id = ${actor.id}
    `),
  ]);

  const rows = (waiting as unknown as { rows?: Array<{ count: number }> }).rows ?? [];

  return {
    teamSize: team.length,
    waitingOnMe: Number(rows[0]?.count ?? 0),
    openInTeam: team.reduce((sum, m) => sum + m.openRequests, 0),
    repsWithoutAccounts: team.filter((m) => !m.hasAccount).length,
  };
}
