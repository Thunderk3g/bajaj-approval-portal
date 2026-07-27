'use server';

import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { zodFieldErrors } from '@/lib/result';
import {
  MIN_PASSWORD_LENGTH,
  countUsers,
  createFirstAdmin,
  type SetupFormState,
} from './first-admin';

// Deliberately loose, and identical to the CLI's rule: strict RFC matching
// rejects legitimate addresses, and the real test is whether the person can
// sign in with what they typed.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SetupSchema = z
  .object({
    name: z.string().min(1, 'Full name is required'),
    email: z.string().regex(EMAIL_PATTERN, 'That does not look like an email address'),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match',
  });

/** `x-forwarded-for` is a list when a proxy chain is involved; the client is first. */
function clientIp(forwardedFor: string | null): string | null {
  return forwardedFor?.split(',')[0]?.trim() || null;
}

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

/**
 * Creates the first administrator from the public /setup page.
 *
 * This is the only unauthenticated mutation in the application, so it carries
 * its own guard rather than inheriting one. The page's render-time check cannot
 * be that guard: a page renders once and is submitted seconds later, and an
 * account created in between would leave a form on screen that is still willing
 * to mint a second administrator. The check is therefore repeated here, and
 * `createFirstAdmin` repeats it again under a lock — the render check is UX,
 * this one is a fast rejection, and the locked one is the control.
 */
export async function createFirstAdminAction(
  _previous: SetupFormState,
  formData: FormData,
): Promise<SetupFormState> {
  if ((await countUsers()) > 0) notFound();

  const parsed = SetupSchema.safeParse({
    name: text(formData, 'name').trim(),
    email: text(formData, 'email').trim().toLowerCase(),
    password: text(formData, 'password'),
    confirmPassword: text(formData, 'confirmPassword'),
  });

  if (!parsed.success) {
    return {
      error: 'Check the highlighted fields and try again.',
      fieldErrors: zodFieldErrors(parsed.error),
    };
  }

  const requestHeaders = await headers();

  const result = await createFirstAdmin({
    name: parsed.data.name,
    email: parsed.data.email,
    password: parsed.data.password,
    ipAddress: clientIp(requestHeaders.get('x-forwarded-for')),
    userAgent: requestHeaders.get('user-agent'),
  });

  // Refused because an account already exists, or because a concurrent request
  // is creating one. Either way this route no longer exists, and saying so is
  // both honest and less useful to an attacker than a description.
  if (!result.ok) notFound();

  // Nothing to show on success: the account exists, the route is now a 404, and
  // the only thing left to do is sign in.
  redirect('/login');
}
