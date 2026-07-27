/**
 * The web twin of `npm run setup:admin` (spec sections 4.2 and 12).
 *
 * Both create the very first administrator and both refuse the moment the
 * `user` table holds anything at all — not "any admin", any account. A
 * deployment seeded with sales reps must not get a second, unauthenticated
 * route to an administrator account, which is why the guard counts users rather
 * than admins, exactly as the CLI does.
 *
 * Kept apart from `actions.ts` so the guard can be raced in a test without
 * driving a form or a Next request context. That matters more than it looks:
 * the interesting failure is two people opening /setup at the same moment, and
 * that is only observable by calling this function twice concurrently.
 */

import { count, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { createUserAccount } from '@/lib/auth/provision';
import { fail, ok, type ActionResult, type FieldErrors } from '@/lib/result';

/** Better Auth is configured with minPasswordLength 12; the CLI enforces the same. */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * Arbitrary but fixed: any two callers naming the same key contend, and nothing
 * else in this codebase takes an advisory lock.
 */
const SETUP_LOCK_KEY = 8_237_411_051;

export const SETUP_COMPLETE_MESSAGE = 'Setup has already been completed.';

export type FirstAdminInput = {
  name: string;
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type FirstAdminResult = ActionResult<{ id: string; email: string }>;

/**
 * What the form renders after a rejected submit; `null` is the untouched form.
 *
 * It lives here rather than in `actions.ts` because that file carries the
 * 'use server' directive, and Next allows a module marked 'use server' to
 * export nothing but async functions.
 */
export type SetupFormState = { error: string; fieldErrors?: FieldErrors } | null;

/** Row count of `user`, the same figure `scripts/setup-admin.ts` refuses on. */
export async function countUsers(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(user);
  return row?.value ?? 0;
}

/**
 * Creates the first administrator, or refuses.
 *
 * The count-then-create sequence is a race on its own: two requests can both
 * read zero before either inserts, and both would then mint an admin on a page
 * that requires no authentication whatsoever. A transaction alone does not fix
 * it either — concurrent SELECTs on an empty table conflict with nothing, so
 * both still see zero.
 *
 * So the check and the create run under an advisory lock, and it is the
 * *non-blocking* `pg_try_advisory_xact_lock`. A blocking lock would have every
 * concurrent request sit inside a transaction, holding a pooled connection,
 * while the winner needs a second connection of its own to insert the user —
 * enough simultaneous requests and the pool is exhausted by waiters and the
 * winner can never finish. Failing fast means at most one request is ever
 * inside this critical section and the losers release their connections
 * immediately.
 */
export async function createFirstAdmin(input: FirstAdminInput): Promise<FirstAdminResult> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${SETUP_LOCK_KEY}) as locked`,
    );
    if (!locked.rows[0]?.locked) {
      // Another request is inside the critical section. By the time this one
      // could be served an account will exist, so the answer is the same.
      return fail(SETUP_COMPLETE_MESSAGE);
    }

    if ((await countUsersWith(tx)) > 0) {
      return fail(SETUP_COMPLETE_MESSAGE);
    }

    const created = await createUserAccount({
      name: input.name,
      email: input.email,
      password: input.password,
      role: 'admin',
      // An administrator is not scoped to a sales book, so there is no SM_ID.
      smId: null,
    });

    // The new admin is its own actor: nobody else exists to have done this, and
    // recording a null actor would lose the one fact worth keeping — which
    // account this bootstrap produced.
    await writeAudit(
      {
        actor: { id: created.id, email: created.email, role: 'admin' },
        action: 'USER_CREATE',
        entityType: 'user',
        entityId: created.id,
        after: { email: created.email, name: input.name.trim(), role: 'admin', smId: null },
        metadata: { via: 'setup', firstAdmin: true },
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      },
      tx,
    );

    return ok({ id: created.id, email: created.email });
  });
}

type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The same count as `countUsers`, read on the connection holding the lock. */
async function countUsersWith(tx: Executor): Promise<number> {
  const [row] = await tx.select({ value: count() }).from(user);
  return row?.value ?? 0;
}
