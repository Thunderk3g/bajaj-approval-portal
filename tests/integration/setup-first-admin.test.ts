import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, user } from '@/db/schema';
import { SETUP_COMPLETE_MESSAGE, countUsers, createFirstAdmin } from '@/app/setup/first-admin';
import { countExistingUsers } from '../../scripts/setup-admin';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * /setup is the only unauthenticated mutation in the application, so its
 * refusal is the access control (spec sections 4.2 and 9). These tests cover
 * the guard rather than the form: what matters is that a second administrator
 * cannot be created, including when two requests arrive at the same instant.
 */

const PASSWORD = 'correct-horse-battery';

const INPUT = {
  name: 'First Admin',
  email: 'first.admin@example.test',
  password: PASSWORD,
};

describe('first-admin setup page guard', () => {
  beforeEach(truncateAll);

  it('creates the first administrator on an empty database', async () => {
    const result = await createFirstAdmin(INPUT);

    expect(result.ok).toBe(true);

    const row = await db.query.user.findFirst({ where: eq(user.email, INPUT.email) });
    expect(row?.role).toBe('admin');
    expect(row?.isActive).toBe(true);
    // An administrator is not scoped to a sales book.
    expect(row?.smId).toBeNull();
  });

  it('writes the USER_CREATE audit row that names the account it produced', async () => {
    await createFirstAdmin({ ...INPUT, ipAddress: '10.1.2.3', userAgent: 'vitest' });

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'USER_CREATE'));
    expect(rows).toHaveLength(1);
    expect(rows[0].actorEmail).toBe(INPUT.email);
    expect(rows[0].actorRole).toBe('admin');
    expect(rows[0].entityType).toBe('user');
    expect(rows[0].ipAddress).toBe('10.1.2.3');
    expect(rows[0].metadata).toMatchObject({ via: 'setup', firstAdmin: true });
    // The password must not survive anywhere in the trail.
    expect(JSON.stringify(rows[0].after)).not.toContain(PASSWORD);
  });

  it('refuses a second attempt once an account exists', async () => {
    await createFirstAdmin(INPUT);

    const second = await createFirstAdmin({ ...INPUT, email: 'second.admin@example.test' });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toBe(SETUP_COMPLETE_MESSAGE);
    expect(await countUsers()).toBe(1);
  });

  it('refuses even when the only existing account is not an admin', async () => {
    // The guard counts users, not admins: a deployment seeded with sales reps
    // must not get a free second route to an administrator account.
    await makeUser({ role: 'sales', smId: 'C2CM21350' });

    const result = await createFirstAdmin(INPUT);

    expect(result.ok).toBe(false);
    expect(await countUsers()).toBe(1);
  });

  it('creates exactly one administrator when two requests race', async () => {
    // The failure this guards against: two people opening /setup at the same
    // moment, both seeing an empty table, and both being allowed to create an
    // admin on a page that requires no authentication at all.
    const [first, second] = await Promise.all([
      createFirstAdmin({ ...INPUT, email: 'race.one@example.test' }),
      createFirstAdmin({ ...INPUT, email: 'race.two@example.test' }),
    ]);

    const succeeded = [first, second].filter((result) => result.ok);
    expect(succeeded).toHaveLength(1);
    expect(await countUsers()).toBe(1);

    const admins = await db.select().from(user).where(eq(user.role, 'admin'));
    expect(admins).toHaveLength(1);
  });

  it('holds under a wider stampede', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createFirstAdmin({ ...INPUT, email: `stampede.${index}@example.test` }),
      ),
    );

    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(await countUsers()).toBe(1);
  });

  it('rejects a password shorter than Better Auth accepts, creating nothing', async () => {
    await expect(createFirstAdmin({ ...INPUT, password: 'short' })).rejects.toThrow(/12 characters/);
    expect(await countUsers()).toBe(0);
  });

  it('agrees with the CLI guard, which refuses on the same count', async () => {
    // scripts/setup-admin.ts and this page are two doors to one privilege. They
    // must not disagree about whether it is open.
    expect(await countExistingUsers()).toBe(await countUsers());

    await createFirstAdmin(INPUT);

    expect(await countExistingUsers()).toBe(1);
    expect(await countUsers()).toBe(1);
  });
});
