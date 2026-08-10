'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/client';
import { requireRole } from '@/lib/auth/rbac';
import { writeAudit } from '@/lib/audit/log';
import { fail, ok, type ActionResult } from '@/lib/result';
import { CHAIN_KEYS, getChain, setChainActive, setChainStages, type ChainKey } from './chains';
import { WorkflowError } from './errors';

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
): Promise<ActionResult<{ stageKeys: string[] }>> {
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
            // Requests already running this chain hold their own copy of the old
            // steps and are unaffected. Recorded so a later reader does not have
            // to reconstruct whether an edit could have disturbed work in flight.
            inFlightUnaffected: true,
          },
        },
        tx,
      );

      return rows;
    });

    refresh(chainKey);
    return ok({ stageKeys: saved.map((s) => s.stageKey) });
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
