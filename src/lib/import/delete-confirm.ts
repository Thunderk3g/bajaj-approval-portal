/**
 * The phrase that unlocks a forced delete.
 *
 * Here rather than in `actions.ts` because that file is `'use server'` and may
 * only export async functions — and the panel has to print the exact words the
 * server compares against. A copy on each side is how the label drifts from the
 * rule and an admin is refused for typing what the screen told them to type.
 *
 * A phrase rather than a second number, deliberately. The box directly above it
 * already takes the record count, and two numeric confirmations on one panel is
 * how somebody types the same number twice and erases audited decisions they
 * never read about.
 */
export const FORCE_DELETE_PHRASE = 'ERASE APPROVALS';

/** Whether what the admin typed unlocks the force. Case and padding forgiven. */
export function matchesForcePhrase(typed: string | undefined | null): boolean {
  return typed?.trim().toUpperCase() === FORCE_DELETE_PHRASE;
}
