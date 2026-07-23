import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';
import { createUserAccount } from '@/lib/auth/provision';
import { countExistingUsers } from '../../scripts/setup-admin';
import { makeUser, truncateAll } from '../helpers/db';

const EMAIL = 'first.admin@example.test';
const PASSWORD = 'correct-horse-battery';

// These cover the guard that decides whether `npm run setup:admin` is allowed
// to proceed, not the readline prompts. Importing the script must therefore be
// side-effect free — if the CLI ever starts on import, this file hangs.
describe('first-admin setup guard', () => {
  beforeEach(truncateAll);

  it('sees an empty user table and lets the first admin be created', async () => {
    expect(await countExistingUsers()).toBe(0);

    const created = await createUserAccount({
      name: 'First Admin',
      email: EMAIL,
      password: PASSWORD,
      role: 'admin',
      smId: null,
    });

    expect(created.role).toBe('admin');
    expect(created.smId).toBeNull();

    const row = await db.query.user.findFirst({ where: eq(user.email, EMAIL) });
    expect(row?.role).toBe('admin');
    expect(row?.isActive).toBe(true);
  });

  it('reports a non-empty table once the first admin exists, so setup must refuse', async () => {
    await createUserAccount({
      name: 'First Admin',
      email: EMAIL,
      password: PASSWORD,
      role: 'admin',
      smId: null,
    });

    const existing = await countExistingUsers();
    expect(existing).toBe(1);
    expect(existing > 0).toBe(true);
  });

  // The guard counts users, not admins. A deployment seeded with only sales
  // reps must not get a free second route to an administrator account.
  it('refuses even when the only existing account is not an admin', async () => {
    await makeUser({ role: 'sales', smId: 'C2CM21350' });

    expect(await countExistingUsers()).toBe(1);
  });

  it('counts every account, not just the first', async () => {
    await makeUser({ role: 'admin' });
    await makeUser({ role: 'approver' });
    await makeUser({ role: 'sales', smId: 'C2CM00001' });

    expect(await countExistingUsers()).toBe(3);
  });
});
