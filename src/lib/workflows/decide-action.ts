'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { fail, ok, type ActionResult } from '@/lib/result';
import { decideStage } from './engine';
import { WorkflowError } from './errors';

/**
 * The one Server Action a manager's decision goes through.
 *
 * `requireSession`, not `requireRole`: the roles that can act on a rung are not
 * a fixed list any more — a chain can route to a team leader, an area manager, a
 * verifier or an approver, and an administrator can add a rung tomorrow that
 * routes somewhere new. Naming them here would mean a second, staler copy of the
 * rule the engine already enforces.
 *
 * Authorization is NOT skipped by that choice; it is moved to where it can be
 * decided correctly. `decideStageWithin` resolves the active rung and refuses an
 * actor who is not the person or role it belongs to, under the same lock that
 * stops two people deciding at once. That check is strictly tighter than a role
 * gate: it narrows a hierarchy rung to one named individual, where
 * `requireRole('tl')` would admit every team leader in the company.
 */

const schema = z.object({
  requestId: z.uuid('That request identifier is not valid.'),
  decision: z.enum(['ADVANCE', 'RETURN', 'REJECT']),
  remarks: z.string().trim().max(2000).nullable().optional(),
});

export type DecideStageFields = z.infer<typeof schema>;

export async function decideStageAction(
  raw: DecideStageFields,
): Promise<ActionResult<{ kind: string }>> {
  // Still requires a signed-in, active account — an inactive one is refused
  // here rather than reaching the engine at all.
  const actor = await requireSession();

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'That decision could not be recorded.');
  }

  try {
    const outcome = await decideStage({
      requestId: parsed.data.requestId,
      actor,
      decision: parsed.data.decision,
      remarks: parsed.data.remarks ?? null,
    });

    for (const path of ['/tl', '/tl/queue', '/acm', '/acm/queue', '/verifier/queue', '/approver/queue']) {
      revalidatePath(path);
    }
    revalidatePath(`/sales/requests/${parsed.data.requestId}`);

    return ok({ kind: outcome.kind });
  } catch (error) {
    if (error instanceof WorkflowError) return fail(error.message);
    // Left to propagate: the layout turns it into a redirect, and converting it
    // to a `fail` would show a signed-out user an inline validation error
    // instead of the login page.
    if (error instanceof AuthzError) throw error;
    throw error;
  }
}
