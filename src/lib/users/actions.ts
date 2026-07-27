'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { fail, type ActionResult } from '@/lib/result';
import { createUser, setUserActive, updateUser } from './service';

/**
 * The Server Action boundary for account administration.
 *
 * Every export calls requireRole('admin') first and independently. Middleware
 * redirects a wrongly-roled browser, but a Server Action is a POST endpoint
 * with a stable id — it can be invoked directly, so the check has to live here
 * (section 4.1). AuthzError is left to propagate; the layout turns it into a
 * redirect, and converting it to a `fail` would show a signed-out user an
 * inline validation error instead of the login page.
 */

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value : '';
}

export async function createUserAction(
  _previous: ActionResult<{ id: string; email: string }> | null,
  form: FormData,
): Promise<ActionResult<{ id: string; email: string }>> {
  const actor = await requireRole('admin');

  const result = await createUser(actor, {
    name: text(form, 'name'),
    email: text(form, 'email'),
    password: text(form, 'password'),
    role: text(form, 'role'),
    smId: text(form, 'smId'),
  });

  if (result.ok) revalidatePath('/admin/users');
  return result;
}

export async function updateUserAction(
  _previous: ActionResult<void> | null,
  form: FormData,
): Promise<ActionResult<void>> {
  const actor = await requireRole('admin');

  const result = await updateUser(actor, {
    userId: text(form, 'userId'),
    name: text(form, 'name'),
    role: text(form, 'role'),
    smId: text(form, 'smId'),
  });

  if (result.ok) revalidatePath('/admin/users');
  return result;
}

export async function setUserActiveAction(
  _previous: ActionResult<void> | null,
  form: FormData,
): Promise<ActionResult<void>> {
  const actor = await requireRole('admin');

  const userId = text(form, 'userId');
  const intent = text(form, 'intent');
  if (intent !== 'activate' && intent !== 'deactivate') {
    return fail('Unrecognised request.');
  }

  const result = await setUserActive(actor, userId, intent === 'activate');

  if (result.ok) revalidatePath('/admin/users');
  return result;
}
