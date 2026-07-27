import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';

export async function truncateAll() {
  await db.execute(sql`
    truncate table
      "correction_event", "correction_attachment", "correction_request",
      "sales_record_version", "sales_record",
      "upload_batch_row", "upload_batch", "manpower",
      "audit_log", "notification", "excel_export",
      "session", "account", "verification", "user"
    restart identity cascade
  `);
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

type UserOverrides = Partial<{
  name: string;
  email: string;
  role: 'admin' | 'sales' | 'approver';
  smId: string | null;
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
      isActive: overrides.isActive ?? true,
    })
    .returning();
  return row;
}
