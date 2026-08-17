import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { approvalChain, approvalChainStage, correctionRequest, user } from '@/db/schema';
import type { DbTransaction } from '@/lib/audit/log';
import { WorkflowError } from './errors';

/**
 * Reading and rewriting the chain DEFINITIONS — 2026-08-06 spec sections 4 and 7.
 *
 * Nothing here touches a request. Editing a chain changes what the NEXT
 * submission will run and cannot reach a request already in flight, because each
 * request materialises its own copy of the stages at submission
 * (`correction_request_stage`). That is the whole reason the admin screen needs
 * no "are you sure, N requests are running this" block.
 */

export type ChainKey =
  | 'AUTOPAY'
  | 'MAPPING_WITHIN_TEAM'
  | 'MAPPING_BETWEEN_TEAMS'
  | 'MAPPING_DIY'
  | 'ISSUANCE_DATE'
  | 'BAU_TO_BFL'
  | 'OTHERS'
  | 'AGENT_ID';

export const CHAIN_KEYS: readonly ChainKey[] = [
  'AUTOPAY',
  'MAPPING_WITHIN_TEAM',
  'MAPPING_BETWEEN_TEAMS',
  'MAPPING_DIY',
  'ISSUANCE_DATE',
  'BAU_TO_BFL',
  'OTHERS',
  'AGENT_ID',
];

export const CHAIN_LABELS: Record<ChainKey, string> = {
  AUTOPAY: 'AutoPay',
  MAPPING_WITHIN_TEAM: 'Mapping — within one team',
  MAPPING_BETWEEN_TEAMS: 'Mapping — between two teams',
  MAPPING_DIY: 'Mapping — unowned / DIY',
  ISSUANCE_DATE: 'Issuance date',
  BAU_TO_BFL: 'BAU to BFL',
  OTHERS: 'Other corrections',
  AGENT_ID: 'Agent ID',
};

export type StageDraft = {
  stageKey: string;
  resolverKey: string;
  resolverConfig?: Record<string, unknown>;
  canReject?: boolean;
};

export type ChainStageRow = typeof approvalChainStage.$inferSelect;

export type LoadedChain = {
  id: string;
  chainKey: ChainKey;
  label: string;
  isActive: boolean;
  stages: ChainStageRow[];
};

export async function getChain(
  chainKey: ChainKey,
  tx?: DbTransaction,
): Promise<LoadedChain | null> {
  const executor = tx ?? db;

  const [chain] = await executor
    .select()
    .from(approvalChain)
    .where(eq(approvalChain.chainKey, chainKey))
    .limit(1);

  if (!chain) return null;

  const stages = await executor
    .select()
    .from(approvalChainStage)
    .where(eq(approvalChainStage.chainId, chain.id))
    .orderBy(asc(approvalChainStage.sequence));

  return {
    id: chain.id,
    chainKey: chain.chainKey as ChainKey,
    label: chain.label,
    isActive: chain.isActive,
    stages,
  };
}

export type ChainSummary = {
  id: string;
  chainKey: ChainKey;
  label: string;
  isActive: boolean;
  stageCount: number;
  stageKeys: string[];
  /** Steps that name a person and name nobody — see `listChains`. */
  unstaffedStageKeys: string[];
  updatedAt: Date;
};

export async function listChains(): Promise<ChainSummary[]> {
  const chains = await db.select().from(approvalChain).orderBy(asc(approvalChain.chainKey));
  const stages = await db
    .select()
    .from(approvalChainStage)
    .orderBy(asc(approvalChainStage.sequence));

  /**
   * Which of the people these chains name still exist and can still sign in.
   *
   * "Has a `userId`" is NOT the same question as "routes to somebody", and the
   * gap between them is not hypothetical: every one of the three chains in this
   * database that looked staffed pointed at a user id that no longer exists, so
   * `AUTOPAY`, `MAPPING_WITHIN_TEAM` and `MAPPING_BETWEEN_TEAMS` each stranded
   * their first step while the admin screen showed them as configured. A
   * deactivated account fails the same way — `activeUserIdsWithRole` and the USER
   * resolver both require `is_active`.
   *
   * One query for every chain rather than one per stage: this is an admin list.
   */
  const namedIds = [
    ...new Set(
      stages
        .map((s) => (s.resolverConfig as { userId?: string } | null)?.userId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const live = new Set(
    namedIds.length === 0
      ? []
      : (
          await db
            .select({ id: user.id })
            .from(user)
            .where(and(inArray(user.id, namedIds), eq(user.isActive, true)))
        ).map((r) => r.id),
  );

  return chains.map((chain) => {
    const own = stages.filter((s) => s.chainId === chain.id);
    return {
      id: chain.id,
      chainKey: chain.chainKey as ChainKey,
      label: chain.label,
      isActive: chain.isActive,
      stageCount: own.length,
      stageKeys: own.map((s) => s.stageKey),
      /**
       * Steps that name a person and then name nobody.
       *
       * A `USER` stage with no `userId` in its config resolves to nobody, so
       * every request routed onto it opens ACTIVE, pinned to no one, and stops
       * dead. Five of the seeded chains ship in exactly that state, which is how
       * a team leader raised a claim and watched it go nowhere with no
       * explanation on any screen. Surfaced on the list because a chain that
       * cannot route is a chain nobody should be raising requests onto, and the
       * only place that was previously visible was the stalled request itself.
       */
      unstaffedStageKeys: own
        .filter((s) => {
          if (s.resolverKey === 'ROLE') return false;
          // A hierarchy step resolves per request from the roster, so it has no
          // person to name here and cannot be judged from the chain alone.
          const config = s.resolverConfig as { userId?: string; smSide?: string } | null;
          if (config?.smSide) return false;
          return !config?.userId || !live.has(config.userId);
        })
        .map((s) => s.stageKey),
      updatedAt: chain.updatedAt,
    };
  });
}

/**
 * Replaces a chain's ENTIRE ordered stage list, transactionally.
 *
 * One write path under every admin gesture — add, remove, reorder — rather than
 * three. Each of those is "here is the new list" once the screen has computed it,
 * and a per-gesture mutation would need its own re-sequencing logic, its own
 * uniqueness handling on `(chain_id, sequence)`, and its own chance of leaving a
 * gap in the order.
 *
 * Takes `FOR UPDATE` on the chain row first: two admins editing the same chain
 * concurrently must serialise, or the second read-modify-write silently discards
 * the first one's edit.
 */
export async function setChainStages(
  tx: DbTransaction,
  chainId: string,
  stages: StageDraft[],
): Promise<ChainStageRow[]> {
  if (stages.length === 0) {
    // A chain with no stages accepts a submission and then has nobody to review
    // it — strictly worse than refusing the edit, because the rep sees a request
    // that looks submitted and never moves.
    throw new WorkflowError(
      'EMPTY_CHAIN',
      'A chain must keep at least one stage — otherwise nothing would ever review these requests.',
    );
  }

  await tx
    .select({ id: approvalChain.id })
    .from(approvalChain)
    .where(eq(approvalChain.id, chainId))
    .limit(1)
    .for('update');

  await tx.delete(approvalChainStage).where(eq(approvalChainStage.chainId, chainId));

  const inserted = await tx
    .insert(approvalChainStage)
    .values(
      stages.map((stage, index) => ({
        chainId,
        sequence: index,
        stageKey: stage.stageKey,
        resolverKey: stage.resolverKey,
        resolverConfig: stage.resolverConfig ?? {},
        // The last stage is what finally applies the change, so it is the one
        // that must also be able to refuse outright. Every earlier rung may pass
        // or send back, mirroring today's verifier-cannot-reject asymmetry.
        canReject: stage.canReject ?? index === stages.length - 1,
      })),
    )
    .returning();

  await tx
    .update(approvalChain)
    .set({ updatedAt: new Date() })
    .where(eq(approvalChain.id, chainId));

  return inserted;
}

export async function setChainActive(
  tx: DbTransaction,
  chainId: string,
  isActive: boolean,
): Promise<void> {
  await tx
    .update(approvalChain)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(approvalChain.id, chainId));
}

/**
 * Creates a chain if it does not exist, leaving an existing one untouched.
 *
 * Idempotent on `chain_key` so the bootstrap below can be re-run — on a fresh
 * database, after a restore, or by a deploy that is not sure whether the last one
 * finished — without overwriting stages an admin has since edited. Silently
 * resetting a customised chain to its seeded shape would be the worst kind of
 * "safe to re-run".
 */
export async function ensureChain(
  tx: DbTransaction,
  chainKey: ChainKey,
  stages: StageDraft[],
): Promise<{ created: boolean; chainId: string }> {
  const [existing] = await tx
    .select({ id: approvalChain.id })
    .from(approvalChain)
    .where(eq(approvalChain.chainKey, chainKey))
    .limit(1);

  if (existing) return { created: false, chainId: existing.id };

  const [chain] = await tx
    .insert(approvalChain)
    .values({ chainKey, label: CHAIN_LABELS[chainKey] })
    .returning({ id: approvalChain.id });

  await setChainStages(tx, chain.id, stages);
  return { created: true, chainId: chain.id };
}

/**
 * The two-stage chain every category ran before this release.
 *
 * Seeded for every chainKey so the engine can be switched on with its behaviour
 * unchanged, and the real per-category chains (spec section 6) replace these one
 * at a time afterwards. Shipping the mechanism and the new business rules in one
 * step would make any regression ambiguous between the two.
 */
export const BOOTSTRAP_STAGES: StageDraft[] = [
  { stageKey: 'V1', resolverKey: 'ROLE', resolverConfig: { role: 'verifier' }, canReject: false },
  { stageKey: 'APPROVER', resolverKey: 'ROLE', resolverConfig: { role: 'approver' }, canReject: true },
];

export async function seedBootstrapChains(): Promise<{ created: ChainKey[] }> {
  const created: ChainKey[] = [];

  await db.transaction(async (tx) => {
    for (const chainKey of CHAIN_KEYS) {
      const result = await ensureChain(tx, chainKey, BOOTSTRAP_STAGES);
      if (result.created) created.push(chainKey);
    }
  });

  return { created };
}

/** How many requests are currently mid-flight on a chain, for the admin screen. */
export async function countInFlight(chainKey: ChainKey): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(correctionRequest)
    .where(
      and(
        eq(correctionRequest.chainKey, chainKey),
        inArray(correctionRequest.status, ['PENDING', 'VERIFIED']),
      ),
    );

  return row?.value ?? 0;
}
