import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';
import type { Role } from '@/lib/auth/rbac';

export async function truncateAll() {
  await db.execute(sql`
    truncate table
      "correction_event", "correction_attachment", "correction_request",
      "sales_record_version", "sales_record", "lead",
      "upload_batch_row", "upload_batch", "manpower",
      "period",
      "audit_log", "notification", "excel_export",
      "session", "account", "verification", "user"
    restart identity cascade
  `);

  await seedChains();
}

/**
 * Re-seeds the approval chains every truncate destroys.
 *
 * `approval_chain.updated_by` references `user`, so the CASCADE above takes the
 * chains with it even though they are not named — and without a chain no
 * correction can be raised or decided at all.
 *
 * BOOTSTRAP, not the designed chains: two stages, a verifier then an approver,
 * which is exactly the flow that existed before the engine. Every pre-existing
 * suite then exercises the new machinery while asserting the old behaviour,
 * which is the strongest available evidence that the refactor changed nothing it
 * was not supposed to. Suites covering the longer chains install their own.
 */
export async function seedChains() {
  const { seedBootstrapChains } = await import('@/lib/workflows/chains');
  await seedBootstrapChains();
}

/** Replaces one chain's stages, for a suite that needs a chain of its own shape. */
export async function useChain(chainKey: string, stages: Array<Record<string, unknown>>) {
  const { getChain, setChainStages } = await import('@/lib/workflows/chains');
  const chain = await getChain(chainKey as never);
  if (!chain) throw new Error(`No chain seeded for ${chainKey}`);
  await db.transaction((tx) => setChainStages(tx, chain.id, stages as never));
}

/**
 * Asserts a query fails with a specific database error.
 *
 * Drizzle wraps driver errors, so the constraint name that actually identifies
 * the violation sits on `error.cause`, not `error.message`. Matching the
 * top-level message would pass for any failure at all, which is worse than no
 * assertion — it would look like the constraint was verified when it was not.
 */
export async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<string> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  if (caught === undefined) {
    throw new Error(`Expected the query to fail matching ${pattern}, but it succeeded`);
  }

  const parts: string[] = [];
  let cursor: unknown = caught;
  while (cursor instanceof Error || (cursor && typeof cursor === 'object')) {
    const e = cursor as { message?: unknown; detail?: unknown; constraint?: unknown; cause?: unknown };
    for (const value of [e.message, e.detail, e.constraint]) {
      if (typeof value === 'string') parts.push(value);
    }
    cursor = e.cause;
  }

  const combined = parts.join(' | ');
  if (!pattern.test(combined)) {
    throw new Error(`Expected a database error matching ${pattern}, got: ${combined}`);
  }
  return combined;
}

// Derived from Role rather than re-listed: a fourth role added to the union and
// not here would silently leave every test unable to construct one, which reads
// as "the feature has no tests" instead of as a compile error.
type UserOverrides = Partial<{
  name: string;
  email: string;
  role: Role;
  smId: string | null;
  tlCode: string | null;
  acmCode: string | null;
  isActive: boolean;
}>;

export async function makeUser(overrides: UserOverrides = {}) {
  const id = randomUUID();
  const role = overrides.role ?? 'admin';
  const [row] = await db
    .insert(user)
    .values({
      id,
      name: overrides.name ?? `Test ${role}`,
      email: overrides.email ?? `${id}@example.test`,
      role,
      smId: overrides.smId !== undefined ? overrides.smId : role === 'sales' ? 'C2CM00001' : null,
      // The CHECK constraints require a manager's code, so a `tl` or `acm` with
      // none would be rejected at insert — defaulted rather than left to every
      // caller to remember.
      tlCode: overrides.tlCode ?? (role === 'tl' ? 'TL000' : null),
      acmCode: overrides.acmCode ?? (role === 'acm' ? 'CCM000' : null),
      isActive: overrides.isActive ?? true,
    })
    .returning();
  return row;
}
