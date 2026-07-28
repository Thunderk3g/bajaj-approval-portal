import { headers } from 'next/headers';
import { eq, type SQL } from 'drizzle-orm';
import { auth } from './server';
import { AuthzError } from './errors';
import { salesRecord } from '@/db/schema';

export type Role = 'admin' | 'sales' | 'approver' | 'verifier';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  smId: string | null;
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
 * The only sanctioned way to scope record reads.
 *
 * Admins, approvers and verifiers see everything. A sales user is confined to
 * their own SM_ID. A sales user with no SM_ID throws rather than returning
 * undefined: "no condition" means "no filter", which would turn one
 * misconfigured account into one that reads every record in the system.
 */
export function scopedRecordCondition(user: SessionUser): SQL | undefined {
  if (GLOBAL_READ_ROLES.includes(user.role)) return undefined;
  if (!user.smId) throw new AuthzError('FORBIDDEN', 'Sales user has no SM_ID');
  return eq(salesRecord.smId, user.smId);
}
