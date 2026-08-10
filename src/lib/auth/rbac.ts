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
 */
export function teamSmIds(column: 'tl_id' | 'ccm_id', code: string): SQL {
  const overridden =
    column === 'tl_id'
      ? sql`coalesce(o.tl_id, m.tl_id)`
      : sql`coalesce(o.ccm_id, m.ccm_id)`;

  return sql`(
    select m.sm_id from manpower m
    left join manpower_override o on o.sm_id = m.sm_id
    where ${overridden} = ${code}
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
