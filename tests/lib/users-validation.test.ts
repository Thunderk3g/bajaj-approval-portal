import { describe, expect, it } from 'vitest';
import { createUserSchema, updateUserSchema, SM_ID_PATTERN } from '@/lib/users/schema';
import { zodFieldErrors } from '@/lib/result';

const BASE = {
  name: 'Ravi Kumar',
  email: 'ravi.kumar@example.test',
  password: 'correct-horse-battery',
  role: 'sales' as const,
  smId: 'C2CM21350',
};

describe('account provisioning validation (spec 4.2)', () => {
  it('uppercases and trims SM_ID before the CHECK constraint ever sees it', () => {
    // user_sm_id_uppercase rejects a lowercase value outright; normalizing here
    // means the admin gets an account rather than a constraint violation.
    const parsed = createUserSchema.parse({ ...BASE, smId: '  c2cm21350 ' });
    expect(parsed.smId).toBe('C2CM21350');
  });

  it('lowercases and trims the email, which is the sign-in identifier', () => {
    const parsed = createUserSchema.parse({ ...BASE, email: '  Ravi.Kumar@Example.Test ' });
    expect(parsed.email).toBe('ravi.kumar@example.test');
  });

  it('accepts a purely numeric SM_ID', () => {
    // 512454 is a live orphan ID in the June data — section 13.2 note 7.
    expect(SM_ID_PATTERN.test('512454')).toBe(true);
    expect(createUserSchema.parse({ ...BASE, smId: '512454' }).smId).toBe('512454');
  });

  it('requires an SM_ID for a sales account and puts the error on the field', () => {
    const result = createUserSchema.safeParse({ ...BASE, smId: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(zodFieldErrors(result.error).smId?.[0]).toMatch(/must have an SM_ID/);
  });

  it.each(['', undefined])('treats %j as no SM_ID at all, not as an empty string', (value) => {
    const result = createUserSchema.safeParse({ ...BASE, role: 'admin', smId: value });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.smId).toBeNull();
  });

  it('refuses an SM_ID on a non-sales account rather than silently dropping it', () => {
    const result = createUserSchema.safeParse({ ...BASE, role: 'approver' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(zodFieldErrors(result.error).smId?.[0]).toMatch(/Only a Sales account/);
  });

  it.each(['ab', 'C2CM 21350', 'c2cm-21350', 'C'.repeat(33)])(
    'rejects %j as an SM_ID',
    (smId) => {
      expect(createUserSchema.safeParse({ ...BASE, smId }).success).toBe(false);
    },
  );

  it('enforces the 12-character minimum Better Auth also enforces', () => {
    const result = createUserSchema.safeParse({ ...BASE, password: 'short' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(zodFieldErrors(result.error).password?.[0]).toMatch(/12 characters/);
  });

  it('rejects an email that is not one', () => {
    expect(createUserSchema.safeParse({ ...BASE, email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects an unknown role rather than defaulting to one', () => {
    // Defaulting a bad role would quietly hand out whichever role we defaulted
    // to; for an account-creation form that is the whole security boundary.
    expect(createUserSchema.safeParse({ ...BASE, role: 'superuser' }).success).toBe(false);
  });

  it('does not accept an email on the update form', () => {
    // Email is stamped onto every audit row this user produced — section 4.6.
    const parsed = updateUserSchema.parse({
      userId: 'u-1',
      name: 'Ravi Kumar',
      role: 'sales',
      smId: 'C2CM21350',
      email: 'someone.else@example.test',
    });
    expect('email' in parsed).toBe(false);
  });
});
