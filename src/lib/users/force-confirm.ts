/**
 * The phrase that unlocks a forced account removal.
 *
 * Here rather than in `actions.ts` because that file is `'use server'` and may
 * only export async functions, and the row has to print the exact words the
 * server compares against.
 *
 * The words name the mechanism, not the intent. "Force" says how hard the admin
 * clicked; PURGE AND DELETE says what actually happens — every audit entry the
 * account is the actor of is destroyed, and then the account is. Somebody typing
 * it has read what it does.
 */
export const FORCE_REMOVE_PHRASE = 'PURGE AND DELETE';

/** Whether what the admin typed unlocks the force. Case and padding forgiven. */
export function matchesForceRemovePhrase(typed: string | undefined | null): boolean {
  return typed?.trim().toUpperCase() === FORCE_REMOVE_PHRASE;
}
