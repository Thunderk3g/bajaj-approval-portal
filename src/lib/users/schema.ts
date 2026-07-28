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

export const ROLES = ['admin', 'sales', 'approver', 'verifier'] as const;

export type UserRole = (typeof ROLES)[number];

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

const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address.'));

const nameSchema = z.string().trim().min(2, 'Enter the full name.').max(120, 'Name is too long.');

// Better Auth is configured with minPasswordLength 12; a shorter value is
// rejected downstream by an exception the form cannot attach to a field.
const passwordSchema = z.string().min(12, 'Password must be at least 12 characters.');

type SmIdIssueCtx = {
  addIssue: (issue: { code: 'custom'; path: (string | number)[]; message: string }) => void;
};

/**
 * A non-sales account carrying an SM_ID is rejected rather than silently
 * cleared. An approver with an SM_ID looks like a scoped account without being
 * one, and the next person to read the row cannot tell which was intended.
 */
function checkSmIdAgainstRole(
  value: { role: UserRole; smId: string | null },
  ctx: SmIdIssueCtx,
): void {
  if (value.role === 'sales' && !value.smId) {
    ctx.addIssue({
      code: 'custom',
      path: ['smId'],
      message: 'A Sales account must have an SM_ID — it is what scopes them to their own records.',
    });
  }
  if (value.role !== 'sales' && value.smId) {
    ctx.addIssue({
      code: 'custom',
      path: ['smId'],
      message: 'Only a Sales account has an SM_ID.',
    });
  }
}

export const createUserSchema = z
  .object({
    name: nameSchema,
    email: emailSchema,
    password: passwordSchema,
    role: z.enum(ROLES),
    smId: optionalSmId,
  })
  .superRefine(checkSmIdAgainstRole);

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
  })
  .superRefine(checkSmIdAgainstRole);

export type UpdateUserFields = z.infer<typeof updateUserSchema>;
