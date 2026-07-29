import { and, asc, count, desc, eq, ilike, notExists, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, roleEnum, salesRecord, user } from '@/db/schema';
import type { UserRole } from './schema';

/** Reads for /admin/users — spec sections 4.2 and 13.2 note 7. */

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  smId: string | null;
  isActive: boolean;
  createdAt: Date;
};

export type UserListOptions = {
  q?: string | null;
  role?: string | null;
  active?: 'active' | 'inactive' | null;
  limit: number;
  offset: number;
};

/**
 * Derived from the enum, not enumerated by hand.
 *
 * The hand-written version listed admin, sales and approver, and was written
 * before `verifier` existed. Because an unrecognised role falls through to "no
 * filter" rather than to an error, `/admin/users?role=verifier` quietly listed
 * every user instead of the verifiers — the filter did not fail, it answered a
 * different question. Deriving it means the next role added to the enum cannot
 * reintroduce that.
 */
const ROLES = new Set<string>(roleEnum.enumValues);

function isRole(value: string): value is UserRole {
  return ROLES.has(value);
}

export async function listUsers(
  options: UserListOptions,
): Promise<{ rows: UserRow[]; total: number }> {
  const parts: SQL[] = [];

  const q = options.q?.trim();
  if (q) {
    const pattern = `%${q}%`;
    const match = or(
      ilike(user.name, pattern),
      ilike(user.email, pattern),
      ilike(user.smId, pattern),
    );
    if (match) parts.push(match);
  }

  const role = options.role?.trim();
  if (role && isRole(role)) parts.push(eq(user.role, role));

  if (options.active === 'active') parts.push(eq(user.isActive, true));
  if (options.active === 'inactive') parts.push(eq(user.isActive, false));

  const where = parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : and(...parts);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        smId: user.smId,
        isActive: user.isActive,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(where)
      // Inactive accounts sink to the bottom: they are the ones an admin is
      // least often looking for and the ones most likely to fill a page.
      .orderBy(desc(user.isActive), desc(user.createdAt))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(user).where(where),
  ]);

  return { rows, total: totals?.value ?? 0 };
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      smId: user.smId,
      isActive: user.isActive,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);

  return row ?? null;
}

export type RosterEntry = {
  smId: string;
  smName: string | null;
  location: string | null;
  /** Seen in transaction data but absent from the Manpower roster. */
  isOrphan: boolean;
  accountEmail: string | null;
  accountIsActive: boolean | null;
};

const ROSTER_LIMIT = 500;

/**
 * The provisioning worklist — every SM_ID that could need a Sales account,
 * annotated with whether one already exists.
 *
 * Built from two sources, not one. The `Manpower` roster is the intended source
 * (section 13.1), but seven SM_IDs in the June `Login Data` have no roster row
 * at all (section 13.2 note 7). Listing only the roster would leave those reps
 * permanently invisible to the admin who has to provision them, so IDs found in
 * `sales_record` with no roster entry are folded in and flagged as orphans —
 * the roster is treated as incomplete rather than as the truth.
 *
 * Merged in the application rather than in one UNION query on purpose: the
 * roster is ~180 rows and the orphan set is single digits, so the cost is
 * nothing and the join semantics stay legible.
 */
export async function listRoster(): Promise<RosterEntry[]> {
  const [rosterRows, orphanRows, salesAccounts] = await Promise.all([
    db
      .select({
        smId: manpower.smId,
        smName: manpower.smName,
        location: manpower.location,
        isOrphan: manpower.isOrphan,
      })
      .from(manpower)
      .orderBy(asc(manpower.smId))
      .limit(ROSTER_LIMIT),

    db
      .select({
        smId: salesRecord.smId,
        smName: sql<string | null>`max(${salesRecord.smName})`,
        location: sql<string | null>`max(${salesRecord.location})`,
      })
      .from(salesRecord)
      .where(
        notExists(
          db
            .select({ one: sql`1` })
            .from(manpower)
            .where(eq(manpower.smId, salesRecord.smId)),
        ),
      )
      .groupBy(salesRecord.smId)
      .orderBy(asc(salesRecord.smId))
      .limit(ROSTER_LIMIT),

    db
      .select({ smId: user.smId, email: user.email, isActive: user.isActive })
      .from(user)
      .where(eq(user.role, 'sales')),
  ]);

  const accounts = new Map(
    salesAccounts
      .filter((a): a is { smId: string; email: string; isActive: boolean } => a.smId !== null)
      .map((a) => [a.smId, a]),
  );

  const entries: RosterEntry[] = [
    ...rosterRows.map((r) => ({
      smId: r.smId,
      smName: r.smName,
      location: r.location,
      isOrphan: r.isOrphan,
      accountEmail: null as string | null,
      accountIsActive: null as boolean | null,
    })),
    ...orphanRows.map((r) => ({
      smId: r.smId,
      smName: r.smName,
      location: r.location,
      isOrphan: true,
      accountEmail: null as string | null,
      accountIsActive: null as boolean | null,
    })),
  ];

  for (const entry of entries) {
    const account = accounts.get(entry.smId);
    if (!account) continue;
    entry.accountEmail = account.email;
    entry.accountIsActive = account.isActive;
  }

  // Unprovisioned first, orphans ahead of roster entries within that: those are
  // the two facts the admin is on this page to act on.
  return entries.sort((a, b) => {
    const provisioned = Number(a.accountEmail !== null) - Number(b.accountEmail !== null);
    if (provisioned !== 0) return provisioned;
    const orphan = Number(b.isOrphan) - Number(a.isOrphan);
    if (orphan !== 0) return orphan;
    return a.smId.localeCompare(b.smId);
  });
}

/** Whether an SM_ID is on the roster, and whether the roster itself flags it. */
export async function rosterStatus(smId: string): Promise<'roster' | 'orphan' | 'absent'> {
  const [row] = await db
    .select({ isOrphan: manpower.isOrphan })
    .from(manpower)
    .where(eq(manpower.smId, smId))
    .limit(1);

  if (!row) return 'absent';
  return row.isOrphan ? 'orphan' : 'roster';
}

export type UserCounts = { total: number; active: number; sales: number; unprovisioned: number };

export async function userCounts(): Promise<UserCounts> {
  const [row] = await db
    .select({
      total: count(),
      active: sql<number>`count(*) filter (where ${user.isActive})::int`,
      sales: sql<number>`count(*) filter (where ${user.role} = 'sales')::int`,
    })
    .from(user);

  const roster = await listRoster();
  const unprovisioned = roster.filter((r) => r.accountEmail === null).length;

  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    sales: row?.sales ?? 0,
    unprovisioned,
  };
}
