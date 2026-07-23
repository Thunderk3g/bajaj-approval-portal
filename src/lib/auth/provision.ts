import { auth } from './server';
import type { Role } from './rbac';

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: Role;
  smId?: string | null;
};

export type CreatedUser = {
  id: string;
  email: string;
  role: Role;
  smId: string | null;
};

/**
 * Creates an account on behalf of an administrator.
 *
 * Public sign-up is disabled, and Better Auth enforces that on the server API
 * too — signUpEmail throws regardless of how it is called. Provisioning
 * therefore goes through the internal adapter, using Better Auth's own
 * password hasher so credentials stay compatible with the sign-in path.
 *
 * SM_ID is uppercased here to match the database CHECK constraint; a lowercase
 * value would otherwise be rejected at insert time with an opaque error.
 */
export async function createUserAccount(input: CreateUserInput): Promise<CreatedUser> {
  const ctx = await auth.$context;

  const email = input.email.trim().toLowerCase();
  const smId = input.smId ? input.smId.trim().toUpperCase() : null;

  if (input.role === 'sales' && !smId) {
    throw new Error('A sales user requires an SM_ID');
  }
  if (input.password.length < 12) {
    throw new Error('Password must be at least 12 characters');
  }

  const existing = await ctx.internalAdapter.findUserByEmail(email);
  if (existing) {
    throw new Error(`A user with email ${email} already exists`);
  }

  const created = await ctx.internalAdapter.createUser({
    name: input.name.trim(),
    email,
    emailVerified: true,
    role: input.role,
    smId,
    isActive: true,
  });

  const hashed = await ctx.password.hash(input.password);

  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: hashed,
  });

  return { id: created.id, email, role: input.role, smId };
}
