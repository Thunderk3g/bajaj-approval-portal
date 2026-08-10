import { and, eq } from 'drizzle-orm';
import { user } from '@/db/schema';
import type { DbTransaction } from '@/lib/audit/log';
import type { Role } from '@/lib/auth/rbac';
import type { correctionRequest, salesRecord } from '@/db/schema';

/**
 * The seam between the engine and the business — 2026-08-06 spec section 4.
 *
 * The engine knows a stage has a `resolverKey` and must produce "who may act
 * here". It knows nothing about teams, locations or categories. Everything that
 * does — the hierarchy module, mainly — registers itself here, so adding a rung
 * that resolves some new way is a registration rather than a change to the state
 * machine.
 */

export type StageContext = {
  request: Pick<
    typeof correctionRequest.$inferSelect,
    'id' | 'recordId' | 'smId' | 'counterpartySmId' | 'category' | 'direction' | 'submittedBy'
  >;
  record: Pick<typeof salesRecord.$inferSelect, 'id' | 'smId' | 'appsNo'> | null;
  stage: {
    sequence: number;
    stageKey: string;
    resolverKey: string;
    resolverConfig: Record<string, unknown>;
  };
};

/**
 * Who may act on a stage, in one of three shapes.
 *
 * `UNRESOLVED` is not an error and must not be treated as one. It is the honest
 * answer when the roster has a gap — an SM with no TL, a TL whose ACM has no
 * account — and the engine's response is to let the request through while
 * telling an admin, rather than stranding it behind data the actor cannot fix.
 * Making it a thrown error instead would mean one missing roster row blocks
 * every request that touches that team.
 */
export type StageAuthorization =
  | { kind: 'ROLE'; role: Role }
  | { kind: 'USERS'; userIds: string[] }
  | { kind: 'UNRESOLVED'; reason: string };

export type StageResolver = {
  resolve: (ctx: StageContext, tx: DbTransaction) => Promise<StageAuthorization>;
};

const RESOLVERS = new Map<string, StageResolver>();

export function registerStageResolver(resolverKey: string, resolver: StageResolver): void {
  RESOLVERS.set(resolverKey, resolver);
}

export async function resolveStageAuthorization(
  ctx: StageContext,
  tx: DbTransaction,
): Promise<StageAuthorization> {
  const resolver = RESOLVERS.get(ctx.stage.resolverKey);
  if (!resolver) {
    // A chain referring to a resolver nobody registered is a configuration
    // error, but it surfaces as UNRESOLVED rather than a throw for the same
    // reason a roster gap does: the request is already in flight and the person
    // who could fix the chain is not the person being blocked by it.
    return {
      kind: 'UNRESOLVED',
      reason: `No resolver is registered for "${ctx.stage.resolverKey}".`,
    };
  }
  return resolver.resolve(ctx, tx);
}

/**
 * The built-in pool resolver: "any active holder of this role may act".
 *
 * Registered by this module rather than by a caller, because it is what makes
 * the engine usable before any hierarchy exists — the bootstrap chains that
 * reproduce today's verifier → approver flow are built entirely from it, so the
 * engine can ship and be exercised while TL/ACM resolution is still being built.
 */
registerStageResolver('ROLE', {
  resolve: async (ctx) => {
    const role = ctx.stage.resolverConfig.role;
    if (typeof role !== 'string') {
      return { kind: 'UNRESOLVED', reason: 'This stage does not name a role to resolve.' };
    }
    return { kind: 'ROLE', role: role as Role };
  },
});

/**
 * A named person, assigned to this step by an administrator.
 *
 * This is what V1, V2, V3 actually are. They are not "any verifier" — they are
 * distinct review positions the business fills with specific people, and that
 * person is usually a team leader or an area manager rather than a rep. Modelling
 * them as a role pool would send every one of them to everybody holding the
 * `verifier` role, which is neither who the business means nor how they staff it.
 *
 * The id is stored on the step rather than on the user, so the same person can
 * hold V2 on one chain and V4 on another without either fact contradicting the
 * other, and reassigning a slot is an edit to the chain rather than to an account.
 */
registerStageResolver('USER', {
  resolve: async (ctx, tx) => {
    const userId = ctx.stage.resolverConfig.userId;
    if (typeof userId !== 'string' || !userId) {
      return {
        kind: 'UNRESOLVED',
        reason: `step "${ctx.stage.stageKey}" has nobody assigned to it yet`,
      };
    }

    const [row] = await tx
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.id, userId), eq(user.isActive, true)))
      .limit(1);

    if (!row) {
      return {
        kind: 'UNRESOLVED',
        reason: `the person assigned to "${ctx.stage.stageKey}" no longer has an active account`,
      };
    }

    return { kind: 'USERS', userIds: [row.id] };
  },
});

/** Active user ids holding a role — the recipients of a `ROLE` stage's notification. */
export async function activeUserIdsWithRole(role: Role, tx: DbTransaction): Promise<string[]> {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.role, role), eq(user.isActive, true)));
  return rows.map((r) => r.id);
}
