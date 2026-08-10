import { auth } from './server';
import type { Role } from './rbac';

export type CreateUserInput = {
  name: string;
  email: string;
  password: string;
  role: Role;
  smId?: string | null;
  /** The roster code a TL or ACM account is scoped by — 2026-08-06 spec §5. */
  tlCode?: string | null;
  acmCode?: string | null;
};

export type CreatedUser = {
  id: string;
  email: string;
  role: Role;
  smId: string | null;
  tlCode: string | null;
  acmCode: string | null;
};

/**
 * Which column scopes each role, or null for the roles that read everything.
 *
 * Mirrors `ROLE_SCOPE_FIELD` in src/lib/users/schema.ts, which is the same table
 * for the admin form. Restated rather than imported so this module — reached by
 * the CLI provisioning scripts, which load nothing that touches `zod` or the
 * request layer — keeps its narrow import surface.
 */
const REQUIRED_CODE: Record<Role, 'smId' | 'tlCode' | 'acmCode' | null> = {
  admin: null,
  approver: null,
  verifier: null,
  sales: 'smId',
  tl: 'tlCode',
  acm: 'acmCode',
};

/**
 * Creates an account on behalf of an administrator.
 *
 * Public sign-up is disabled, and Better Auth enforces that on the server API
 * too — signUpEmail throws regardless of how it is called. Provisioning
 * therefore goes through the internal adapter, using Better Auth's own
 * password hasher so credentials stay compatible with the sign-in path.
 *
 * Every scoping code is uppercased here to match the database CHECK constraints;
 * a lowercase value would otherwise be rejected at insert time with an opaque
 * error, and a TL whose code was stored lowercase would resolve as nobody's
 * manager while looking perfectly correct in the admin list.
 */
export async function createUserAccount(input: CreateUserInput): Promise<CreatedUser> {
  const ctx = await auth.$context;

  const email = input.email.trim().toLowerCase();
  const upper = (value: string | null | undefined) =>
    value ? value.trim().toUpperCase() : null;

  const smId = upper(input.smId);
  const tlCode = upper(input.tlCode);
  const acmCode = upper(input.acmCode);

  const required = REQUIRED_CODE[input.role];
  const codes = { smId, tlCode, acmCode };
  if (required && !codes[required]) {
    const label = { smId: 'an SM_ID', tlCode: 'a TL code', acmCode: 'an ACM code' }[required];
    throw new Error(`A ${input.role} user requires ${label}`);
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
    tlCode,
    acmCode,
    isActive: true,
  });

  const hashed = await ctx.password.hash(input.password);

  await ctx.internalAdapter.createAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: hashed,
  });

  return { id: created.id, email, role: input.role, smId, tlCode, acmCode };
}
