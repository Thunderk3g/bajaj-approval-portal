import { and, count, eq, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, manpower, manpowerOverride, salesRecord, user } from '@/db/schema';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';
import { teamSmIds, type SessionUser } from '@/lib/auth/rbac';
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
  /** The team leader's own name, so the column is readable without a lookup. */
  tlName: string | null;
  /** True when this member leads a team of their own inside this manager's scope. */
  isTeamLeader: boolean;
  recordCount: number;
  openRequests: number;
  /**
   * Whether this person can sign in, and — separately — whether that login still
   * works. "Never provisioned" and "deactivated" need different remedies, and a
   * single boolean told the manager to ask for an account that already exists.
   */
  account: 'ACTIVE' | 'INACTIVE' | 'NONE';
};

export async function listTeam(actor: SessionUser): Promise<TeamMember[]> {
  const scope = managerScope(actor);

  /**
   * Membership is `teamSmIds` — the SAME subquery that scopes every record read.
   *
   * It used to restate the predicate inline, and the restatement is exactly how
   * the two drifted: the record grid resolves a manager's people one way and the
   * People screen another, so a manager could see a rep's policies in one place
   * and not the rep in the other. One definition, asked twice.
   *
   * Two exclusions on top. The manager's OWN roster row, because the sheet writes
   * a self-row naming the manager at all three rungs and this list is defined as
   * the people BENEATH them — that row is why an area manager opening People found
   * himself sitting in his own team looking like a second, login-less account.
   * It stays in `teamSmIds`, where it carries the manager's own production; it has
   * no business in a list of reports. And the bucket codes, which are business
   * with nobody attached rather than somebody this manager can be asked about.
   */
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
        sql`${manpower.smId} in ${teamSmIds(scope.column, scope.code)}`,
        ne(manpower.smId, scope.code),
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
    /**
     * Accounts matched by CODE at any rung, never by `sm_id` alone.
     *
     * A team leader's login carries `tl_code` and an area manager's carries
     * `acm_code`; neither has an `sm_id`. Matching only `sm_id` therefore reported
     * every provisioned manager in the list as having no login — on an ACM's
     * screen that is every team leader under him at once, and the dashboard tile
     * built from it told him to ask an administrator to provision people who were
     * already provisioned. `listRoster` has always matched all three columns; this
     * query is the one that did not.
     */
    db
      .select({
        smId: user.smId,
        tlCode: user.tlCode,
        acmCode: user.acmCode,
        isActive: user.isActive,
      })
      .from(user)
      .where(
        or(
          inArray(user.smId, ids),
          inArray(user.tlCode, ids),
          inArray(user.acmCode, ids),
        ),
      ),
  ]);

  const recordBy = new Map(records.map((r) => [r.smId, r.value]));
  const openBy = new Map(open.map((r) => [r.smId, r.value]));

  // An active login anywhere wins over a deactivated one: a person who was
  // deactivated at one rung and re-provisioned at another can sign in.
  const accountBy = new Map<string, 'ACTIVE' | 'INACTIVE'>();
  for (const row of accounts) {
    for (const code of [row.smId, row.tlCode, row.acmCode]) {
      if (!code) continue;
      if (row.isActive || !accountBy.has(code)) {
        accountBy.set(code, row.isActive ? 'ACTIVE' : 'INACTIVE');
      }
    }
  }

  // A member leads a team when somebody else in this list reports to them, or
  // when their own row names them as their own team leader — the two shapes the
  // Manpower sheet uses for the same fact.
  const leaderCodes = new Set(members.map((m) => m.tlId).filter((id): id is string => Boolean(id)));
  const nameByCode = new Map(members.map((m) => [m.smId, m.smName]));

  return members.map((m) => ({
    smId: m.smId,
    smName: m.smName,
    location: m.location,
    tlId: m.tlId,
    // The manager's own code names nobody in this list — they were excluded from
    // it — so fall back to their own name rather than rendering a bare code.
    tlName:
      m.tlId === null
        ? null
        : m.tlId === scope.code
          ? actor.name
          : (nameByCode.get(m.tlId) ?? null),
    isTeamLeader: leaderCodes.has(m.smId),
    recordCount: recordBy.get(m.smId) ?? 0,
    openRequests: openBy.get(m.smId) ?? 0,
    account: accountBy.get(m.smId) ?? 'NONE',
  }));
}

export type ManagerSummary = {
  teamSize: number;
  waitingOnMe: number;
  openInTeam: number;
  repsWithoutAccounts: number;
  /** Zero for a TL — they have reps, not team leaders. */
  teamLeaders: number;
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
    // 'NONE' only. A deactivated login is an account an admin must re-enable, not
    // one they must create, and counting it here sent managers to ask for the
    // wrong thing.
    repsWithoutAccounts: team.filter((m) => m.account === 'NONE').length,
    teamLeaders: actor.role === 'acm' ? team.filter((m) => m.isTeamLeader).length : 0,
  };
}

/* --------------------------------------------------- what my team has raised */

export type TeamRequestRow = {
  id: string;
  appsNo: string;
  category: string;
  fieldLabel: string;
  originalValue: string | null;
  proposedValue: string;
  status: string;
  smId: string;
  smName: string | null;
  submitterName: string | null;
  submittedAt: Date;
  /** Null once the request is decided — there is no open rung left to name. */
  stageKey: string | null;
  stageSequence: number | null;
  totalStages: number;
  /** True when the open rung is this manager's own. */
  mine: boolean;
  /** True when the rung resolved to nobody and is waiting on an administrator. */
  unresolved: boolean;
};

/**
 * Every correction in flight anywhere under this manager, and where each is stuck.
 *
 * The screen behind the "Open in team" figure, which was a number with nothing
 * behind it — the one question a manager opens the portal to ask, "where is my
 * team's work stuck", had a count and no list. Their own queue answers "what is
 * waiting on ME", which is a different and much smaller question: a request
 * parked with a verifier two rungs above them is exactly what they need to see
 * and exactly what that queue excludes.
 *
 * Scoped through `teamSmIds`, the same subquery as the record grid and the People
 * screen, so a manager cannot reach a request outside their own cluster and the
 * three screens cannot disagree about who is in it.
 */
export async function listTeamRequests(
  actor: SessionUser,
  filters: { smId?: string | null } = {},
): Promise<TeamRequestRow[]> {
  const scope = managerScope(actor);

  const rows = await db.execute<TeamRequestRow>(sql`
    select r.id                as "id",
           r.apps_no           as "appsNo",
           r.category          as "category",
           r.field_label       as "fieldLabel",
           r.original_value    as "originalValue",
           r.proposed_value    as "proposedValue",
           r.status            as "status",
           r.sm_id             as "smId",
           m.sm_name           as "smName",
           u.name              as "submitterName",
           r.submitted_at      as "submittedAt",
           s.stage_key         as "stageKey",
           s.sequence          as "stageSequence",
           r.total_stages      as "totalStages",
           coalesce(s.assigned_user_id = ${actor.id}, false)          as "mine",
           coalesce(s.assigned_user_id is null
                    and s.resolver_key <> 'ROLE', false)              as "unresolved"
      from correction_request r
      left join correction_request_stage s
             on s.request_id = r.id and s.status = 'ACTIVE'
      left join manpower m on m.sm_id = r.sm_id
      left join "user" u on u.id = r.submitted_by
     where r.sm_id in ${teamSmIds(scope.column, scope.code)}
       and r.status in ('PENDING','VERIFIED','RETURNED')
       ${filters.smId ? sql`and r.sm_id = ${filters.smId.toUpperCase()}` : sql``}
     order by r.submitted_at asc
  `);

  return ((rows as unknown as { rows?: TeamRequestRow[] }).rows ?? (rows as unknown as TeamRequestRow[]));
}
