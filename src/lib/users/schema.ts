import { z } from 'zod';

/**
 * Validation for admin-driven account provisioning — spec section 4.2.
 *
 * The database already enforces the two rules that matter: `role = 'sales'`
 * implies `sm_id IS NOT NULL`, and `sm_id = upper(sm_id)`. Repeating them here
 * is not redundancy for its own sake — a CHECK violation surfaces as
 * `new row for relation "user" violates check constraint
 * "user_sales_requires_sm_id"`, which tells an administrator nothing about what
 * to type instead. The constraint is the guarantee; this is the explanation.
 */

export const ROLES = ['admin', 'sales', 'approver', 'verifier', 'tl', 'acm'] as const;

export type UserRole = (typeof ROLES)[number];

/**
 * Which column scopes each role, or null for the roles that read everything.
 *
 * One table rather than a chain of `if (role === ...)` in three places: the form
 * renders the right field from it, the validator below enforces exactly one code
 * per account from it, and adding a seventh role is a line here rather than three
 * edits that can disagree.
 */
export const ROLE_SCOPE_FIELD: Record<UserRole, 'smId' | 'tlCode' | 'acmCode' | null> = {
  admin: null,
  approver: null,
  verifier: null,
  sales: 'smId',
  tl: 'tlCode',
  // The ACM's code IS the CCM code off the Manpower sheet — one rung, two names
  // (2026-08-06 spec §2).
  acm: 'acmCode',
};

export const SCOPE_FIELD_LABELS: Record<'smId' | 'tlCode' | 'acmCode', string> = {
  smId: 'an SM_ID',
  tlCode: 'a TL code',
  acmCode: 'an ACM (CCM) code',
};

/**
 * Shown beside each option on the create-user form.
 *
 * A verifier and an approver look identical on a role dropdown — both review
 * other people's corrections, neither carries an SM_ID — and picking the wrong
 * one produces an account that silently sees an empty queue. Saying which stage
 * each sits at is the difference between a label and an explanation.
 */
export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  admin: 'Imports workbooks, manages accounts and periods, generates exports.',
  sales: 'Sees only their own SM_ID and raises correction requests. Requires an SM_ID.',
  verifier: 'First review. Checks a submitted request against its proof, then passes it to an approver or returns it to the rep.',
  approver: 'Second review. Applies the correction to the record, or rejects or returns it.',
  tl: 'Team leader. Sees the reps reporting to them, raises requests on their behalf, and signs off mapping changes. Requires a TL code from the Manpower sheet.',
  acm: 'Area manager. Signs off mapping changes for every team at their locations. Requires the CCM code the Manpower sheet carries for them.',
};

/**
 * Digits alone are allowed deliberately.
 *
 * One live SM_ID in the June data — 512454 — is purely numeric (section 13.2
 * note 7). A rule demanding a letter prefix would reject a real person, and the
 * orphan IDs are exactly the accounts an admin has to create by hand.
 */
export const SM_ID_PATTERN = /^[A-Z0-9]{3,32}$/;

const SM_ID_MESSAGE = 'SM_ID must be 3–32 letters or digits, with no spaces.';

/**
 * Uppercased before it is validated, not after.
 *
 * Six reps appear in both cases in the source workbook (section 6.3), and an
 * account keyed to the lowercase form would never join to that rep's records.
 * An empty field becomes null rather than '' so the CHECK constraint sees an
 * honest absence.
 */
const optionalSmId = z
  .string()
  .trim()
  .toUpperCase()
  .optional()
  .transform((value) => (value ? value : null))
  .refine((value) => value === null || SM_ID_PATTERN.test(value), { message: SM_ID_MESSAGE });

/**
 * TL and ACM codes take the same shape as an SM_ID, and for the same reasons.
 *
 * They come off the same Manpower sheet, in the same identifier family, and the
 * purely-numeric case that forced `SM_ID_PATTERN` to admit digits alone applies
 * to a manager's code exactly as it does to a rep's. Reusing the pattern rather
 * than restating it is what keeps `/admin/users` and the provisioning scripts
 * accepting the same set of codes.
 */
const optionalOrgCode = (label: string) =>
  z
    .string()
    .trim()
    .toUpperCase()
    .optional()
    .transform((value) => (value ? value : null))
    .refine((value) => value === null || SM_ID_PATTERN.test(value), {
      message: `${label} must be 3–32 letters or digits, with no spaces.`,
    });

const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.'));

const nameSchema = z.string().trim().min(2, 'Enter the full name.').max(120, 'Name is too long.');

// Better Auth is configured with minPasswordLength 12; a shorter value is
// rejected downstream by an exception the form cannot attach to a field.
const passwordSchema = z.string().min(12, 'Password must be at least 12 characters.');

type SmIdIssueCtx = {
  addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void;
};

type ScopedFields = {
  role: UserRole;
  smId: string | null;
  tlCode: string | null;
  acmCode: string | null;
};

const SCOPE_REQUIRED_MESSAGE: Record<'smId' | 'tlCode' | 'acmCode', string> = {
  smId: 'A Sales account must have an SM_ID — it is what scopes them to their own records.',
  tlCode: 'A Team leader account must have a TL code — it is what resolves their reps and their approval stages.',
  acmCode: 'An Area manager account must have an ACM (CCM) code — it is what resolves the teams they sign off for.',
};

/**
 * Exactly one scoping code, and it must be the one the role actually reads.
 *
 * Both halves matter. A missing code leaves an account that resolves to nobody:
 * a TL with no `tl_code` owns no reps, so every stage routed to them silently
 * finds no assignee. A code on the WRONG field — or on a role that has none — is
 * the subtler failure, because the row looks scoped without being scoped, and the
 * next person to read it cannot tell which was intended. Both are rejected here
 * rather than cleared, so the admin is told what to type instead.
 */
function checkScopeAgainstRole(value: ScopedFields, ctx: SmIdIssueCtx): void {
  const expected = ROLE_SCOPE_FIELD[value.role];

  if (expected && !value[expected]) {
    ctx.addIssue({ code: 'custom', path: [expected], message: SCOPE_REQUIRED_MESSAGE[expected] });
  }

  for (const field of ['smId', 'tlCode', 'acmCode'] as const) {
    if (field !== expected && value[field]) {
      // Named by the role that DOES carry the field, not by the role that does
      // not. "Only a Sales account has an SM_ID" tells the admin where the value
      // belongs; "an Approver account does not carry an SM_ID" only tells them
      // where it does not, and leaves them guessing.
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `Only a ${OWNING_ROLE_LABEL[field]} account has ${SCOPE_FIELD_LABELS[field]}.`,
      });
    }
  }
}

const OWNING_ROLE_LABEL: Record<'smId' | 'tlCode' | 'acmCode', string> = {
  smId: 'Sales',
  tlCode: 'Team leader',
  acmCode: 'Area manager',
};


export const createUserSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(ROLES),
    smId: optionalSmId,
    tlCode: optionalOrgCode('TL code'),
    acmCode: optionalOrgCode('ACM code'),
  })
  .superRefine(checkScopeAgainstRole);

export type CreateUserFields = z.infer<typeof createUserSchema>;

/**
 * Email is absent on purpose.
 *
 * It is the sign-in identifier and it is stamped onto every audit row this user
 * has ever produced. Letting it be edited would leave the trail pointing at an
 * address that resolves to nobody, which is the confusion section 4.6
 * denormalizes the column to avoid in the first place.
 */
export const updateUserSchema = z
  .object({
    userId: z.string().min(1),
    name: nameSchema,
    role: z.enum(ROLES),
    smId: optionalSmId,
    tlCode: optionalOrgCode('TL code'),
    acmCode: optionalOrgCode('ACM code'),
  })
  .superRefine(checkScopeAgainstRole);

export type UpdateUserFields = z.infer<typeof updateUserSchema>;
