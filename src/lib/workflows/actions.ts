'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { requireRole } from '@/lib/auth/rbac';
import { writeAudit } from '@/lib/audit/log';
import { fail, ok, type ActionResult } from '@/lib/result';
import { CHAIN_KEYS, getChain, setChainActive, setChainStages, type ChainKey } from './chains';
import { WorkflowError } from './errors';
import { reassignOpenStages, retryRoutingForChain, retryStageRouting } from './engine';

/**
 * Editing an approval chain — 2026-08-06 spec section 7.
 *
 * Admin only, and `requireRole` runs here rather than relying on the layout: a
 * Server Action is a POST endpoint reachable without rendering the page that
 * guards it. Changing who signs off a correction is a change to what other people
 * are allowed to do, so it is audited on every path.
 *
 * Every gesture the screen offers — reorder by dragging, add a step, remove one,
 * switch the chain off — lands on ONE write, `setChainStages`, which replaces the
 * whole ordered list transactionally. Per-gesture mutations would each need their
 * own re-sequencing and their own handling of the `(chain_id, sequence)`
 * uniqueness, and a dropped stage or a duplicated position is not something the
 * admin would see until a request routed wrongly.
 */

const stageSchema = z.object({
  stageKey: z.string().trim().min(1, 'Every step needs a name.').max(40),
  resolverKey: z.string().trim().min(1),
  resolverConfig: z.record(z.string(), z.unknown()).default({}),
  canReject: z.boolean().default(false),
});

const saveSchema = z.object({
  chainKey: z.enum(CHAIN_KEYS as unknown as [ChainKey, ...ChainKey[]]),
  stages: z.array(stageSchema).min(1, 'A chain must keep at least one step.'),
});

export type SaveChainInput = z.infer<typeof saveSchema>;

function refresh(chainKey: string) {
  revalidatePath('/admin/workflows');
  revalidatePath(`/admin/workflows/${chainKey}`);
}

export async function saveChainStagesAction(
  raw: SaveChainInput,
): Promise<
  ActionResult<{
    stageKeys: string[];
    rerouted: number;
    stillStuck: number;
    /** In-flight requests moved to a review position's new owner. */
    reassigned: number;
  }>
> {
  const actor = await requireRole('admin');

  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? 'That chain could not be saved.');
  }

  const { chainKey, stages } = parsed.data;

  const before = await getChain(chainKey);
  if (!before) {
    return fail(
      `No chain exists for ${chainKey}. Run "npx tsx scripts/seed-workflow-chains.ts" to create the missing ones.`,
    );
  }

  try {
    const saved = await db.transaction(async (tx) => {
      const rows = await setChainStages(tx, before.id, stages);

      await writeAudit(
        {
          actor,
          // One action name for the whole edit. The before/after lists below say
          // exactly what moved, was added or was dropped, which is more useful
          // after the fact than three action names that each describe a gesture
          // rather than an outcome.
          action: 'WORKFLOW_CHAIN_STAGE_REORDER',
          entityType: 'approval_chain',
          entityId: before.id,
          before: { stages: before.stages.map(describe) },
          after: { stages: rows.map(describe) },
          metadata: {
            chainKey,
            // Requests already running this chain hold their own copy of the
            // ordered steps, and that list is never rewritten under them — no
            // rung is added, removed or reordered mid-flight.
            //
            // WHO an open rung belongs to is the exception, applied after this
            // transaction commits and in two shapes: a rung that resolved to
            // NOBODY froze nothing worth keeping (`retryRoutingForChain`), and a
            // review position handed to a different person follows the person
            // (`reassignOpenStages`).
            inFlightStageListFrozen: true,
          },
        },
        tx,
      );

      return rows;
    });

    /**
     * Route whatever was stranded on this chain, now that it can be routed.
     *
     * AFTER the commit, never inside it. The chain edit is the thing the admin
     * asked for and it must not be rolled back because one of the requests
     * behind it turns out to be unroutable for an unrelated reason — and each
     * re-resolution takes its own row locks, which is a poor thing to do while
     * holding the chain lock this transaction took.
     *
     * This is the answer to "I assigned a verifier afterwards and the request
     * still went nowhere": before, the stranded rungs stayed stranded and
     * nothing in the product could move them.
     */
    const rerouted = await retryRoutingForChain(chainKey).catch(() => []);

    /**
     * And move whatever is sitting on a rung this edit just handed to somebody
     * else — the other half of the same complaint.
     *
     * `retryRoutingForChain` above covers a rung that resolved to NOBODY.
     * Reassigning a review position from one person to another is the case it
     * cannot see: the rung resolved fine, to the person who no longer holds the
     * desk, so the request stayed in their queue and was invisible to the person
     * who now does. Only ACTIVE `USER` rungs move, and never one already decided
     * — see `reassignOpenStages`.
     */
    const reassigned = await reassignOpenStages(
      chainKey,
      saved.flatMap((stage) => {
        const userId = (stage.resolverConfig as { userId?: unknown })?.userId;
        return stage.resolverKey === 'USER' && typeof userId === 'string' && userId
          ? [{ stageKey: stage.stageKey, userId }]
          : [];
      }),
    ).catch(() => []);

    refresh(chainKey);
    return ok({
      stageKeys: saved.map((s) => s.stageKey),
      rerouted: rerouted.filter((r) => r.routed).length,
      stillStuck: rerouted.filter((r) => !r.routed).length,
      reassigned: reassigned.reduce((sum, r) => sum + r.moved, 0),
    });
  } catch (error) {
    if (error instanceof WorkflowError) return fail(error.message);
    throw error;
  }
}

function describe(stage: {
  sequence: number;
  stageKey: string;
  resolverKey: string;
  resolverConfig: Record<string, unknown>;
  canReject: boolean;
}) {
  return {
    sequence: stage.sequence,
    stageKey: stage.stageKey,
    resolverKey: stage.resolverKey,
    resolverConfig: stage.resolverConfig,
    canReject: stage.canReject,
  };
}

const activeSchema = z.object({
  chainKey: z.enum(CHAIN_KEYS as unknown as [ChainKey, ...ChainKey[]]),
  isActive: z.boolean(),
});

/**
 * Switching a chain off stops NEW requests of that kind being raised.
 *
 * It does not touch anything already moving — those hold their own copy of the
 * steps — which is why this is safe to use as a stop-gap while a chain is being
 * rebuilt, and why the screen says so rather than warning about work in flight.
 */
export async function setChainActiveAction(
  raw: z.infer<typeof activeSchema>,
): Promise<ActionResult<{ isActive: boolean }>> {
  const actor = await requireRole('admin');

  const parsed = activeSchema.safeParse(raw);
  if (!parsed.success) return fail('That chain could not be updated.');

  const { chainKey, isActive } = parsed.data;
  const chain = await getChain(chainKey);
  if (!chain) return fail(`No chain exists for ${chainKey}.`);

  await db.transaction(async (tx) => {
    await setChainActive(tx, chain.id, isActive);
    await writeAudit(
      {
        actor,
        action: isActive ? 'WORKFLOW_CHAIN_STAGE_ADD' : 'WORKFLOW_CHAIN_STAGE_REMOVE',
        entityType: 'approval_chain',
        entityId: chain.id,
        before: { isActive: chain.isActive },
        after: { isActive },
        metadata: { chainKey, whole_chain: true },
      },
      tx,
    );
  });

  refresh(chainKey);
  return ok({ isActive });
}

const retrySchema = z.object({ requestId: z.uuid() });

/**
 * Re-routes one stranded rung, on demand.
 *
 * The chain-edit path (`saveChainStagesAction`) covers the case where the fix was
 * naming somebody on the chain. This covers the other one, which the chain never
 * sees: the rung named a real manager all along and that manager simply had no
 * portal account, so `resolveApprover` answered `NOT_PROVISIONED`. Creating the
 * account fixes the roster and touches no chain, so nothing would otherwise tell
 * the stranded request to look again.
 *
 * Admin-only, because these rungs are already the administrators' to clear —
 * `assertMayDecide` says so, and this is the same authority exercised earlier:
 * routing it to its rightful owner rather than deciding it on their behalf.
 */
export async function retryStageRoutingAction(
  raw: unknown,
): Promise<ActionResult<{ routed: boolean; stageKey: string; reason: string | null }>> {
  await requireRole('admin');

  const parsed = retrySchema.safeParse(raw);
  if (!parsed.success) return fail('That request could not be identified.');

  const outcome = await retryStageRouting(parsed.data.requestId);

  if (!outcome) {
    return fail('That request has no open step — there is nothing waiting to be routed.');
  }

  revalidatePath('/admin/corrections');
  revalidatePath(`/admin/corrections/${parsed.data.requestId}`);

  return ok({ routed: outcome.routed, stageKey: outcome.stageKey, reason: outcome.reason });
}
