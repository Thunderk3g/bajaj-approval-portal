import { and, asc, eq, isNull, notInArray, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, manpowerOverride, user } from '@/db/schema';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';
import type { DbTransaction } from '@/lib/audit/log';

/**
 * The SM → TL → ACM tree, as the rest of the system needs to read it —
 * 2026-08-06 spec section 5.
 *
 * Two sources, one answer. `manpower` is whatever the latest Manpower sheet said
 * and is overwritten unconditionally on every import; `manpower_override` is what
 * an admin pinned and is never touched by an import. The override wins here and
 * only here, which is what lets the admin screen show both and the drift between
 * them without either table having to know about the other.
 *
 * "ACM" resolves off `ccm_id`. They are one rung under two names (spec §2), so
 * there is one column, one resolver, and no third level to keep in step.
 */

export type HierarchyNode = {
  smId: string;
  smName: string | null;
  location: string | null;
  tlId: string | null;
  tlName: string | null;
  tlSource: 'override' | 'sheet' | null;
  acmId: string | null;
  acmName: string | null;
  acmSource: 'override' | 'sheet' | null;
  isOrphan: boolean;
};

export async function resolveHierarchy(
  smId: string,
  tx?: DbTransaction,
): Promise<HierarchyNode | null> {
  const executor = tx ?? db;

  const [row] = await executor
    .select({
      smId: manpower.smId,
      smName: manpower.smName,
      location: manpower.location,
      isOrphan: manpower.isOrphan,
      sheetTlId: manpower.tlId,
      sheetTlName: manpower.tlName,
      sheetCcmId: manpower.ccmId,
      sheetCcmName: manpower.ccmName,
      overrideTlId: manpowerOverride.tlId,
      overrideCcmId: manpowerOverride.ccmId,
    })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(eq(manpower.smId, smId.toUpperCase()))
    .limit(1);

  if (!row) return null;

  const tlId = row.overrideTlId ?? row.sheetTlId;
  const acmId = row.overrideCcmId ?? row.sheetCcmId;

  /**
   * An overridden code takes its NAME from the account, not from the sheet.
   *
   * The sheet's `tl_name` describes whoever the sheet thinks the manager is. Once
   * an admin has pointed the rep at somebody else, that name belongs to a
   * different person, and showing it beside the new code is the kind of quietly
   * wrong that survives a review — same reason a mapping approval resolves
   * `sm_name` from the roster instead of trusting what was typed.
   */
  const [tlName, acmName] = await Promise.all([
    row.overrideTlId ? nameForCode(executor, row.overrideTlId) : row.sheetTlName,
    row.overrideCcmId ? nameForCode(executor, row.overrideCcmId) : row.sheetCcmName,
  ]);

  return {
    smId: row.smId,
    smName: row.smName,
    location: row.location,
    tlId,
    tlName: tlName ?? null,
    tlSource: tlId ? (row.overrideTlId ? 'override' : 'sheet') : null,
    acmId,
    acmName: acmName ?? null,
    acmSource: acmId ? (row.overrideCcmId ? 'override' : 'sheet') : null,
    isOrphan: row.isOrphan,
  };
}

/**
 * The account that holds a manager code, whichever rung it holds it at.
 *
 * By code rather than by column, and that is the whole rule: one person is one
 * account at their highest rung (see `buildRoster`), so `112224 Sagar Chavan` is
 * an ACM carrying `acm_code` — and the eight reps whose sheet line names 112224
 * as their TEAM LEADER must still resolve their TL rung to him. Matching
 * `user.tl_code` alone answered nobody and dropped every one of those steps on
 * the administrators.
 *
 * Ordered, because the predicate can in principle match two rows — a code left
 * on an old account and reused on a new one — and an unordered `limit(1)` would
 * route the same rep to a different manager on different requests.
 */
function heldBy(code: string) {
  return and(or(eq(user.tlCode, code), eq(user.acmCode, code)), eq(user.isActive, true));
}

async function nameForCode(
  executor: DbTransaction | typeof db,
  code: string,
): Promise<string | null> {
  const [row] = await executor
    .select({ name: user.name })
    .from(user)
    .where(heldBy(code))
    .orderBy(asc(user.createdAt))
    .limit(1);
  return row?.name ?? null;
}

/**
 * Who signs off a TL or ACM rung for a given rep — the one function the engine's
 * resolvers call.
 *
 * Three outcomes, not two, because the two failure modes need different
 * remediation and telling them apart is the whole value:
 *
 *   NO_CODE          the roster does not place this rep under anyone. A data gap
 *                    — chase the Manpower sheet.
 *   NOT_PROVISIONED  the roster names a manager who has no portal account. An
 *                    account gap — chase an administrator.
 *
 * Neither throws. A request already in flight must not be stranded behind data
 * the person holding it cannot fix; the engine opens the rung, tells the admins,
 * and records a warning.
 */
export type ApproverResolution =
  | { status: 'RESOLVED'; userId: string; code: string; name: string }
  | { status: 'NO_CODE' }
  | { status: 'NOT_PROVISIONED'; code: string };

export async function resolveApprover(
  stageRole: 'TL' | 'ACM',
  smId: string,
  tx?: DbTransaction,
): Promise<ApproverResolution> {
  const executor = tx ?? db;

  const node = await resolveHierarchy(smId, tx);
  const code = stageRole === 'TL' ? node?.tlId : node?.acmId;
  if (!code) return { status: 'NO_CODE' };

  const [account] = await executor
    .select({ id: user.id, name: user.name })
    .from(user)
    .where(heldBy(code))
    .orderBy(asc(user.createdAt))
    .limit(1);

  if (!account) return { status: 'NOT_PROVISIONED', code };

  return { status: 'RESOLVED', userId: account.id, code, name: account.name };
}

/* ------------------------------------------------------------------- gaps */

export type HierarchyGap = {
  kind: 'SM_UNPLACED' | 'TL_UNPROVISIONED' | 'ACM_UNPROVISIONED';
  code: string;
  name: string | null;
  smCount: number;
};

/**
 * Everything an admin has to fix before the chains can route cleanly.
 *
 * Three shapes, one list, because they land on one screen and are worked through
 * together: reps the roster places nowhere, and manager codes the roster names
 * that no account carries. Each is a rung that would otherwise open, resolve to
 * nobody, and fall to the admins one request at a time.
 *
 * The sheet's bucket codes are left out at every rung. They sit on the roster as
 * their own team leader and area manager, so they read as three gaps apiece — and
 * none of the three can ever be closed, because provisioning refuses to give a
 * bucket a login. A worklist row nobody can action is worse than no row: it
 * teaches the admin that this card is noise.
 */
export async function listHierarchyGaps(): Promise<HierarchyGap[]> {
  const unplaced = await db
    .select({ code: manpower.smId, name: manpower.smName })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(
      and(
        notInArray(manpower.smId, PLACEHOLDER_CODE_LIST),
        or(
          eq(manpower.isOrphan, true),
          and(
            isNull(manpowerOverride.tlId),
            isNull(manpower.tlId),
          ),
        ),
      ),
    );

  const managerRows = await db.execute<{
    kind: string;
    code: string;
    name: string | null;
    sm_count: number;
  }>(sql`
    with effective as (
      select
        m.sm_id,
        coalesce(o.tl_id, m.tl_id)   as tl_id,
        coalesce(o.ccm_id, m.ccm_id) as ccm_id,
        m.tl_name,
        m.ccm_name
      from manpower m
      left join manpower_override o on o.sm_id = m.sm_id
    )
    select 'TL_UNPROVISIONED' as kind, e.tl_id as code,
           min(e.tl_name) as name, count(*)::int as sm_count
      from effective e
     where e.tl_id is not null
       and e.tl_id not in ${PLACEHOLDER_CODE_LIST}
       and not exists (
         -- Either column: the person holding this code may hold it as their ACM
         -- code, which resolveApprover accepts for a TL rung. Testing tl_code
         -- alone reported an area manager who already answers these steps as an
         -- unprovisioned team leader, and no account an admin could create would
         -- ever clear it.
         select 1 from "user" u
          where (u.tl_code = e.tl_id or u.acm_code = e.tl_id) and u.is_active = true
       )
     group by e.tl_id
    union all
    select 'ACM_UNPROVISIONED' as kind, e.ccm_id as code,
           min(e.ccm_name) as name, count(*)::int as sm_count
      from effective e
     where e.ccm_id is not null
       and e.ccm_id not in ${PLACEHOLDER_CODE_LIST}
       and not exists (
         select 1 from "user" u
          where (u.tl_code = e.ccm_id or u.acm_code = e.ccm_id) and u.is_active = true
       )
     group by e.ccm_id
  `);

  const managers = (managerRows as unknown as { rows?: unknown[] }).rows ?? managerRows;

  return [
    ...unplaced.map((r) => ({
      kind: 'SM_UNPLACED' as const,
      code: r.code,
      name: r.name,
      smCount: 1,
    })),
    ...(managers as Array<{ kind: string; code: string; name: string | null; sm_count: number }>).map(
      (r) => ({
        kind: r.kind as HierarchyGap['kind'],
        code: r.code,
        name: r.name,
        smCount: Number(r.sm_count),
      }),
    ),
  ];
}
