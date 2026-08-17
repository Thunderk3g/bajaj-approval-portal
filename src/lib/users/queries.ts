import { and, count, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, manpowerOverride, roleEnum, user } from '@/db/schema';
import { likePattern } from '@/lib/records/query';
import { buildRoster, byRungThenCode, type RosterEntry } from '@/lib/roster/entries';
import type { UserRole } from './schema';

/** Reads for /admin/users — spec sections 4.2 and 13.2 note 7. */

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  smId: string | null;
  tlCode: string | null;
  acmCode: string | null;
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

/**
 * The filter behind the list, as a predicate.
 *
 * Extracted so `listUserIds` cannot drift from `listUsers`. "Select everyone
 * these filters match" is only safe while the two agree exactly on what they
 * match — a selection built from a subtly different predicate deletes accounts
 * the admin was never shown.
 */
function userFilter(options: Omit<UserListOptions, 'limit' | 'offset'>): SQL | undefined {
  const parts: SQL[] = [];

  const q = options.q?.trim();
  if (q) {
    // Escaped, not interpolated: a hand-built `%${q}%` reads the admin's term as
    // a pattern, so searching for `_` matches every name and `%` matches the
    // whole table. Imported rather than re-derived — one escaping rule, one
    // place for it to be wrong.
    const pattern = likePattern(q);
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

  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0] : and(...parts);
}

export async function listUsers(
  options: UserListOptions,
): Promise<{ rows: UserRow[]; total: number }> {
  const where = userFilter(options);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        smId: user.smId,
        tlCode: user.tlCode,
        acmCode: user.acmCode,
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

/**
 * Every id the current filters match, not just the page being looked at.
 *
 * What "select all" has to mean before a mass removal is possible at all. The
 * checkbox column can only offer the 25 rows the page rendered, so removing 400
 * deactivated accounts meant sixteen rounds of select-page, type-the-count,
 * confirm — and the count changes under you each time, because deleting a page
 * pulls the next one up into its place.
 *
 * Ids only, and ordered, so a few thousand of them cost one indexed scan and
 * about 40 bytes each on the way to the browser. The removal itself still goes
 * through `removeUsers`, one account at a time, with every one of its rules
 * intact — this widens the SELECTION, not what may be deleted.
 */
export async function listUserIds(
  options: Omit<UserListOptions, 'limit' | 'offset'>,
): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(userFilter(options))
    .orderBy(desc(user.isActive), desc(user.createdAt));

  return rows.map((r) => r.id);
}

export type RosterWorklistEntry = RosterEntry & {
  accountEmail: string | null;
  accountIsActive: boolean | null;
};

/**
 * The Manpower sheet with any admin override applied, in one round trip.
 *
 * `coalesce` is the same precedence `resolveHierarchy` uses: a rep an admin has
 * moved is somebody else's report now, and a worklist built off the raw sheet
 * would offer the wrong manager an account for a team they no longer hold. The
 * sheet's own columns come along beside it so team NAMES stay attributable to a
 * rep the sheet itself places there.
 */
async function loadRoster(batchId?: string): Promise<RosterEntry[]> {
  const rows = await db
    .select({
      smId: manpower.smId,
      smName: manpower.smName,
      location: manpower.location,
      isOrphan: manpower.isOrphan,
      tlId: sql<string | null>`coalesce(${manpowerOverride.tlId}, ${manpower.tlId})`,
      ccmId: sql<string | null>`coalesce(${manpowerOverride.ccmId}, ${manpower.ccmId})`,
      sheetTlId: manpower.tlId,
      tlName: manpower.tlName,
      sheetCcmId: manpower.ccmId,
      ccmName: manpower.ccmName,
    })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    // Scoped to one workbook when the caller asks — the upload wizard's roster
    // step lists the people THIS file introduced, not the whole company.
    .where(batchId ? eq(manpower.sourceBatchId, batchId) : undefined);

  return buildRoster(rows);
}

/**
 * The provisioning worklist — everybody the Manpower sheet names, at every rung,
 * and whether each already has a login.
 *
 * The sheet is the only source; see the header of src/lib/roster/entries.ts for
 * why nothing here consults imported transaction data, and how a manager is
 * recognised when the sheet gives them no row of their own.
 *
 * The account lookup is per RUNG, not per code. A code can legitimately hold two
 * of them — one person who leads a team inside the cluster they head — and
 * matching on the code alone would report the area manager's account as covering
 * the team-leader rung, hiding the one gap that still routes to nobody.
 *
 * `batchId` narrows the ROSTER to the rows one workbook wrote; the account
 * lookup below stays global, because an account created from any screen is still
 * an account and offering a second one for the same code is the duplicate
 * identity this list exists to prevent.
 */
export async function listRoster(
  options: { batchId?: string } = {},
): Promise<RosterWorklistEntry[]> {
  const [entries, accounts] = await Promise.all([
    loadRoster(options.batchId),
    db
      .select({
        smId: user.smId,
        tlCode: user.tlCode,
        acmCode: user.acmCode,
        email: user.email,
        isActive: user.isActive,
      })
      .from(user),
  ]);

  /**
   * By CODE, not by rung.
   *
   * A code is one person now — `buildRoster` collapses a multi-rung code to its
   * highest rung — so an account carrying it at any rung is that person's
   * account. Keying per rung, as this did, would report the area manager as
   * having no team-leader login and offer a second one in his name, which is
   * exactly the duplicate identity the collapse exists to remove.
   *
   * Not filtered to a role either: the CHECK constraints permit any role to
   * carry a code, and whatever holds it, a second account for the same code is a
   * second login onto one person's book.
   */
  const held = new Map<string, { email: string; isActive: boolean }>();

  for (const account of accounts) {
    const value = { email: account.email, isActive: account.isActive };
    for (const code of [account.smId, account.tlCode, account.acmCode]) {
      if (code) held.set(code, value);
    }
  }

  return entries
    .map((entry) => {
      const account = held.get(entry.code) ?? null;
      return {
        ...entry,
        accountEmail: account?.email ?? null,
        accountIsActive: account?.isActive ?? null,
      };
    })
    .sort((a, b) => {
      // Unprovisioned first, then top of the hierarchy down: a rep's account is
      // worth little until somebody exists to approve their corrections.
      const provisioned = Number(a.accountEmail !== null) - Number(b.accountEmail !== null);
      return provisioned !== 0 ? provisioned : byRungThenCode(a, b);
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
