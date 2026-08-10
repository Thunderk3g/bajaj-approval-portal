'use server';

import { revalidatePath } from 'next/cache';
import { requireRole } from '@/lib/auth/rbac';
import { fail, type ActionResult } from '@/lib/result';
import {
  createUser,
  provisionRosterAccounts,
  removeRosterEntries,
  removeUsers,
  setUserActive,
  updateUser,
  type BulkRemovalOutcome,
  type RosterProvisionOutcome,
  type RosterRemovalOutcome,
} from './service';

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
    tlCode: text(form, 'tlCode'),
    acmCode: text(form, 'acmCode'),
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
    tlCode: text(form, 'tlCode'),
    acmCode: text(form, 'acmCode'),
  });

  if (result.ok) revalidatePath('/admin/users');
  return result;
}

/**
 * Removes several accounts at once.
 *
 * The ids arrive as repeated `userId` entries rather than as one delimited
 * string: a comma-joined list is one escaping bug away from deleting the wrong
 * row, and `getAll` is what the form already produces from a checkbox column.
 */
export async function removeUsersAction(
  _previous: ActionResult<BulkRemovalOutcome> | null,
  form: FormData,
): Promise<ActionResult<BulkRemovalOutcome>> {
  const actor = await requireRole('admin');

  const ids = form.getAll('userId').filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) return fail('Select at least one account.');

  // Typed confirmation for a batch large enough that a mis-click is expensive.
  // The threshold is deliberately low: this deletes people's access.
  if (ids.length > 10 && text(form, 'confirm').trim() !== String(ids.length)) {
    return fail(`Type ${ids.length} to confirm removing ${ids.length} accounts.`);
  }

  const result = await removeUsers(actor, ids);
  if (result.ok) revalidatePath('/admin/users');
  return result;
}

/**
 * Creates accounts for several worklist entries at once — reps, team leaders
 * and area managers alike.
 *
 * The result carries passwords that exist nowhere else, so this action returns
 * them rather than redirecting: a redirect would discard the only copy. The
 * repeated `key` entries mirror `removeUsersAction` — a comma-joined list is one
 * escaping bug away from provisioning somebody nobody asked for. Each key is
 * `rung:code`, because one person can hold two rungs and the code alone would
 * not say which account was wanted.
 */
export async function provisionRosterAccountsAction(
  _previous: ActionResult<RosterProvisionOutcome> | null,
  form: FormData,
): Promise<ActionResult<RosterProvisionOutcome>> {
  const actor = await requireRole('admin');

  const keys = form.getAll('key').filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (keys.length === 0) return fail('Select at least one person from the roster.');

  // Same threshold as removeUsersAction. Creating accounts is not destructive,
  // but a mis-click still mints working logins whose passwords are shown once
  // and then gone, so the batch large enough to be expensive is confirmed the
  // same way the batch large enough to be dangerous is.
  if (keys.length > 10 && text(form, 'confirm').trim() !== String(keys.length)) {
    return fail(`Type ${keys.length} to confirm creating ${keys.length} accounts.`);
  }

  const result = await provisionRosterAccounts(actor, keys);
  if (result.ok) revalidatePath('/admin/users');
  return result;
}

/**
 * Strikes several entries off the Manpower roster.
 *
 * Typed confirmation at ANY size, unlike the two bulk actions above. This one
 * deletes rows of the roster that every approval chain resolves against, and
 * the only way back is to re-import the sheet that carried them — so there is no
 * batch small enough to be cheap.
 */
export async function removeRosterEntriesAction(
  _previous: ActionResult<RosterRemovalOutcome> | null,
  form: FormData,
): Promise<ActionResult<RosterRemovalOutcome>> {
  const actor = await requireRole('admin');

  const keys = form.getAll('key').filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (keys.length === 0) return fail('Select at least one roster entry.');

  if (text(form, 'confirm').trim() !== String(keys.length)) {
    return fail(`Type ${keys.length} to confirm removing ${keys.length} from the roster.`);
  }

  const result = await removeRosterEntries(actor, keys);
  if (result.ok) {
    revalidatePath('/admin/users');
    // The tree, the unplaced list and the gap card all read the same rows.
    revalidatePath('/admin/hierarchy');
  }
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
