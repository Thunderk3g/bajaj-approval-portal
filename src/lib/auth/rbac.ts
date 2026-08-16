import { headers } from 'next/headers';
import { eq, sql, type SQL } from 'drizzle-orm';
import { auth } from './server';
import { AuthzError } from './errors';
import { salesRecord } from '@/db/schema';

export type Role = 'admin' | 'sales' | 'approver' | 'verifier' | 'tl' | 'acm';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  smId: string | null;
  /**
   * The roster code a manager's authority comes from — 2026-08-06 spec §5.
   *
   * Uppercased on the way out for the same reason `smId` is: the roster stores
   * `tl_id`/`ccm_id` uppercase, `resolveApprover` matches on them, and a session
   * carrying either in the file's own casing would resolve as nobody's manager.
   *
   * Optional rather than `string | null`, and the distinction is deliberate:
   * absent and null mean the same thing here — this account carries no such code
   * — and `scopedRecordCondition` already refuses either. `getSession` always
   * writes both explicitly, so the optionality is never observable in a real
   * session; what it buys is that every caller constructing a session for a role
   * that has no manager code says nothing instead of saying `null` twice.
   */
  tlCode?: string | null;
  acmCode?: string | null;
  isActive: boolean;
};

export async function getSession(): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user) return null;
  const u = result.user as unknown as SessionUser;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    smId: u.smId ? u.smId.toUpperCase() : null,
    tlCode: u.tlCode ? u.tlCode.toUpperCase() : null,
    acmCode: u.acmCode ? u.acmCode.toUpperCase() : null,
    isActive: u.isActive,
  };
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new AuthzError('UNAUTHENTICATED');
  if (!user.isActive) throw new AuthzError('INACTIVE');
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireSession();
  if (!roles.includes(user.role)) throw new AuthzError('FORBIDDEN');
  return user;
}

/**
 * Roles that review other people's work and therefore read every record.
 *
 * A verifier is unscoped for the same reason an approver is: one who could only
 * see part of the queue would leave the rest unverifiable by anyone, and there
 * is no second verifier pool to pick up the remainder.
 *
 * Named rather than inlined so `scopedRecordCondition` and the proof-serving
 * route agree by construction. Those two are the whole of the read boundary; if
 * they ever disagree about who is global, one of them is a hole.
 */
export const GLOBAL_READ_ROLES: readonly Role[] = ['admin', 'approver', 'verifier'];

/**
 * The book a manager is answerable for, as an SM_ID subquery.
 *
 * Reads the EFFECTIVE hierarchy, not the raw sheet: an admin who has reassigned a
 * rep to a different TL has moved that rep's records with them, and a scope that
 * consulted only `manpower` would show the old manager records they no longer own
 * while hiding them from the new one. `coalesce` is the same precedence
 * `resolveHierarchy` applies, restated here in SQL because this runs as a
 * subquery inside somebody else's WHERE.
 *
 * Three unions, because the roster is FLAT and one column of it is not the whole
 * tree. Each closes a way a manager was blind to business they answer for:
 *
 *   the reps named directly   the original predicate, and the common case.
 *
 *   the manager's own code    a working TL or ACM books policies themselves, so
 *                             their own SM_ID owns records. Usually the sheet also
 *                             carries a self-row for them and the first union
 *                             already catches it — but not always: the July
 *                             workbook has `503576` existing only as three other
 *                             reps' CCM_ID, with no row of its own. Naming the
 *                             code directly makes the case that has a self-row and
 *                             the case that does not behave identically, which is
 *                             the only way a manager cannot lose their own
 *                             production to a roster shape they never see.
 *
 *   the reps under my TLs     `ccm_id` only. A rep row states its TL and its ACM
 *                             independently, and the two can disagree: three reps
 *                             in the July roster name TL `ICCSP82423` while naming
 *                             a DIFFERENT area manager than that TL's own row
 *                             does. Under the direct predicate alone the TL's own
 *                             area manager could not see a single policy of that
 *                             team — the reported "an ACM cannot see what the team
 *                             leaders under him issued", exactly.
 *
 * The last union deliberately WIDENS rather than picking a winner between the two
 * disagreeing columns. Code cannot know which of them is the typo, and the cost of
 * guessing wrong is a manager silently blind to a team; the cost of the union is
 * that an inconsistent rep counts in two clusters until somebody fixes the sheet.
 * `listHierarchyGaps` reports that disagreement as `TEAM_ACM_MISMATCH` so it is
 * fixed in the data rather than papered over here.
 */
export function teamSmIds(column: 'tl_id' | 'ccm_id', code: string): SQL {
  if (column === 'tl_id') {
    return sql`(
      select m.sm_id from manpower m
      left join manpower_override o on o.sm_id = m.sm_id
      where coalesce(o.tl_id, m.tl_id) = ${code}
      union
      select ${code}::text
    )`;
  }

  return sql`(
    select m.sm_id from manpower m
    left join manpower_override o on o.sm_id = m.sm_id
    where coalesce(o.ccm_id, m.ccm_id) = ${code}
    union
    select ${code}::text
    union
    select m2.sm_id from manpower m2
    left join manpower_override o2 on o2.sm_id = m2.sm_id
    where coalesce(o2.tl_id, m2.tl_id) in (
      select m3.sm_id from manpower m3
      left join manpower_override o3 on o3.sm_id = m3.sm_id
      where coalesce(o3.ccm_id, m3.ccm_id) = ${code}
    )
  )`;
}

/**
 * The only sanctioned way to scope record reads.
 *
 * Admins, approvers and verifiers see everything. A sales user is confined to
 * their own SM_ID. A TL or ACM sees the reps beneath them and nobody else — they
 * act on those reps' requests, so they must be able to read what they are
 * deciding about, and no further.
 *
 * Every role that is not globally readable throws when its scoping code is
 * missing, rather than returning undefined. "No condition" means "no filter",
 * which would turn one misconfigured account into one that reads every record in
 * the system — the same reasoning for a TL with no `tl_code` as for a sales user
 * with no SM_ID.
 *
 * Whether TL/ACM should instead read globally like a verifier is spec §9 open
 * question 7. Scoped is the safe default to ship on: widening a scope later
 * breaks nothing, narrowing one after people have relied on it does.
 */
export function scopedRecordCondition(user: SessionUser): SQL | undefined {
  if (GLOBAL_READ_ROLES.includes(user.role)) return undefined;

  if (user.role === 'tl') {
    if (!user.tlCode) throw new AuthzError('FORBIDDEN', 'TL user has no TL code');
    return sql`${salesRecord.smId} in ${teamSmIds('tl_id', user.tlCode)}`;
  }

  if (user.role === 'acm') {
    if (!user.acmCode) throw new AuthzError('FORBIDDEN', 'ACM user has no ACM code');
    return sql`${salesRecord.smId} in ${teamSmIds('ccm_id', user.acmCode)}`;
  }

  if (!user.smId) throw new AuthzError('FORBIDDEN', 'Sales user has no SM_ID');
  return eq(salesRecord.smId, user.smId);
}
