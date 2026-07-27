import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { createUserAccount } from '@/lib/auth/provision';
import type { SessionUser } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { createUserSchema, updateUserSchema } from './schema';
import { rosterStatus } from './queries';

/**
 * Account administration — spec section 4.2.
 *
 * The actor is an explicit parameter rather than something read from the
 * session in here. These functions are called from Server Actions that have
 * already established who is asking, and keeping the resolution there means the
 * authorization check and the audit actor are the same value by construction —
 * they cannot drift into an action that checks one identity and logs another.
 * It also lets the invariants below be tested without forging a session cookie.
 */

type Actor = Pick<SessionUser, 'id' | 'email' | 'role'>;

/** The fields worth carrying into the audit trail. Never the password. */
function snapshot(row: {
  name: string;
  email: string;
  role: string;
  smId: string | null;
  isActive: boolean;
}) {
  return {
    name: row.name,
    email: row.email,
    role: row.role,
    smId: row.smId,
    isActive: row.isActive,
  };
}

export async function createUser(
  actor: Actor,
  raw: unknown,
): Promise<ActionResult<{ id: string; email: string }>> {
  const parsed = createUserSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const input = parsed.data;

  // Recorded from the database, not from a hidden form field: whether this
  // SM_ID is a real roster entry or an orphan (section 13.2 note 7) is a fact
  // about the data, and an admin reviewing the trail later needs the fact, not
  // whatever the page happened to render at the time.
  const roster = input.smId ? await rosterStatus(input.smId) : null;

  let created: { id: string; email: string };
  try {
    created = await createUserAccount({
      name: input.name,
      email: input.email,
      password: input.password,
      role: input.role,
      smId: input.smId,
    });
  } catch (error) {
    // createUserAccount throws for a duplicate email, a sales account with no
    // SM_ID, and a short password. All three are the administrator's input, so
    // they belong on the form rather than on an error page.
    const message = error instanceof Error ? error.message : 'Could not create the account.';
    return fail(message);
  }

  await writeAudit({
    actor,
    action: 'USER_CREATE',
    entityType: 'user',
    entityId: created.id,
    after: { name: input.name, email: input.email, role: input.role, smId: input.smId },
    metadata: {
      // 'absent' means the SM_ID appears nowhere in the roster at all. Flagged
      // rather than blocked — section 13.2 note 7 requires the account be
      // creatable and surfaced for admin review.
      roster: roster ?? 'not_applicable',
      needsRosterReview: roster === 'absent' || roster === 'orphan',
    },
  });

  return ok({ id: created.id, email: created.email });
}

export async function updateUser(actor: Actor, raw: unknown): Promise<ActionResult<void>> {
  const parsed = updateUserSchema.safeParse(raw);
  if (!parsed.success) {
    return fail('Check the highlighted fields.', zodFieldErrors(parsed.error));
  }

  const input = parsed.data;

  const [before] = await db.select().from(user).where(eq(user.id, input.userId)).limit(1);
  if (!before) return fail('That account no longer exists.');

  /**
   * An admin cannot demote themselves.
   *
   * The system can reach a state with no usable administrator this way: the
   * first-admin CLI refuses to run once any user exists, so recovery would mean
   * editing the `user` table by hand. Changing somebody else's role is fine —
   * the point is that the person making the change keeps the ability to undo it.
   */
  if (actor.id === input.userId && input.role !== 'admin') {
    return fail('You cannot change your own role. Ask another administrator.');
  }

  const [after] = await db
    .update(user)
    .set({ name: input.name, role: input.role, smId: input.smId, updatedAt: new Date() })
    .where(eq(user.id, input.userId))
    .returning();

  await writeAudit({
    actor,
    action: 'USER_UPDATE',
    entityType: 'user',
    entityId: input.userId,
    before: snapshot(before),
    after: snapshot(after),
  });

  return ok();
}

export async function setUserActive(
  actor: Actor,
  userId: string,
  isActive: boolean,
): Promise<ActionResult<void>> {
  /**
   * An admin must not be able to deactivate their own account.
   *
   * Sessions are checked against `is_active` on every request (section 4.3), so
   * the click would sign them out mid-action and leave them unable to sign back
   * in to undo it. If they were the only active admin, nobody could: there is no
   * public sign-up and `setup:admin` refuses to run once any user exists, so the
   * only remedy left is an UPDATE run by hand against the database.
   */
  if (actor.id === userId && !isActive) {
    return fail('You cannot deactivate your own account. Ask another administrator.');
  }

  const [before] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!before) return fail('That account no longer exists.');

  if (before.isActive === isActive) return ok();

  const [after] = await db
    .update(user)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(user.id, userId))
    .returning();

  // Reactivation is an update, not an un-deactivation: USER_DEACTIVATE reads as
  // an event that happened, and using it for the reverse would make the trail
  // lie about which direction the account moved.
  await writeAudit({
    actor,
    action: isActive ? 'USER_UPDATE' : 'USER_DEACTIVATE',
    entityType: 'user',
    entityId: userId,
    before: snapshot(before),
    after: snapshot(after),
    metadata: { field: 'isActive' },
  });

  return ok();
}
