import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { account, user } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { createUserAccount } from '@/lib/auth/provision';
import { truncateAll } from '../helpers/db';

const EMAIL = 'admin@example.test';
const PASSWORD = 'correct-horse-battery';

describe('account provisioning', () => {
  beforeEach(truncateAll);

  it('creates an admin and signs them in', async () => {
    await createUserAccount({ name: 'Test Admin', email: EMAIL, password: PASSWORD, role: 'admin' });
    const result = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });
    expect(result.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    await createUserAccount({ name: 'Test Admin', email: EMAIL, password: PASSWORD, role: 'admin' });
    let status = 200;
    try {
      const result = await auth.api.signInEmail({
        body: { email: EMAIL, password: 'wrong-password-entirely' },
        asResponse: true,
      });
      status = result.status;
    } catch (error) {
      status = (error as { statusCode?: number }).statusCode ?? 401;
    }
    expect(status).toBeGreaterThanOrEqual(400);
  });

  it('stores a hashed password, never the plaintext', async () => {
    await createUserAccount({ name: 'Test Admin', email: EMAIL, password: PASSWORD, role: 'admin' });
    const rows = await db.select().from(account);
    expect(rows).toHaveLength(1);
    expect(rows[0].password).toBeTruthy();
    expect(rows[0].password).not.toContain(PASSWORD);
  });

  it('uppercases SM_ID so it satisfies the database constraint', async () => {
    const created = await createUserAccount({
      name: 'Rep',
      email: 'rep@example.test',
      password: PASSWORD,
      role: 'sales',
      smId: 'c2cm21350',
    });
    expect(created.smId).toBe('C2CM21350');
    const row = await db.query.user.findFirst({ where: eq(user.email, 'rep@example.test') });
    expect(row?.smId).toBe('C2CM21350');
  });

  it('refuses to create a sales user with no SM_ID', async () => {
    await expect(
      createUserAccount({ name: 'Rep', email: 'rep2@example.test', password: PASSWORD, role: 'sales' }),
    ).rejects.toThrow(/requires an SM_ID/);
  });

  it('refuses a duplicate email', async () => {
    await createUserAccount({ name: 'Test Admin', email: EMAIL, password: PASSWORD, role: 'admin' });
    await expect(
      createUserAccount({ name: 'Other', email: EMAIL, password: PASSWORD, role: 'admin' }),
    ).rejects.toThrow(/already exists/);
  });

  it('refuses a password shorter than 12 characters', async () => {
    await expect(
      createUserAccount({ name: 'Weak', email: 'weak@example.test', password: 'short', role: 'admin' }),
    ).rejects.toThrow(/at least 12/);
  });
});

describe('public sign-up is closed', () => {
  beforeEach(truncateAll);

  // The public HTTP route is the escalation surface: if it ever opens, anyone
  // could self-register. This asserts it stays shut.
  it('rejects sign-up through the public API', async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: 'self@example.test', password: PASSWORD, name: 'Self' } }),
    ).rejects.toThrow();
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(0);
  });
});
