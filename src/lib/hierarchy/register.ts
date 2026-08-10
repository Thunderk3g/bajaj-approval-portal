import { registerStageResolver, type StageAuthorization } from '@/lib/workflows/resolvers';
import { resolveApprover } from './queries';

/**
 * Plugs the org hierarchy into the workflow engine — 2026-08-06 spec §4/§5.
 *
 * Imported for its side effect, from `@/lib/workflows` and nowhere else, so the
 * registration happens exactly once no matter which entry point loads first. The
 * engine deliberately does not import this module itself: it would invert the
 * dependency and make the state machine know about teams, which is the thing the
 * resolver seam exists to prevent.
 */

/**
 * Which side of a mapping request a rung asks about.
 *
 * `SUBMITTER` is the rep whose book the request was raised from; `COUNTERPARTY`
 * is the other side, frozen on the request at submission. A between-team chain
 * runs an ACM rung of each, and this is the only thing that distinguishes them.
 */
function smIdForSide(
  side: unknown,
  request: { smId: string; counterpartySmId: string | null },
): { smId: string } | { missing: string } {
  if (side === 'COUNTERPARTY') {
    if (!request.counterpartySmId) {
      return { missing: 'this request records no counterparty to route to' };
    }
    return { smId: request.counterpartySmId };
  }
  return { smId: request.smId };
}

function describe(
  stageRole: 'TL' | 'ACM',
  smId: string,
  resolution: Awaited<ReturnType<typeof resolveApprover>>,
): StageAuthorization {
  if (resolution.status === 'RESOLVED') {
    return { kind: 'USERS', userIds: [resolution.userId] };
  }
  if (resolution.status === 'NO_CODE') {
    return {
      kind: 'UNRESOLVED',
      reason: `the roster does not record a ${stageRole} for ${smId}`,
    };
  }
  return {
    kind: 'UNRESOLVED',
    reason: `${stageRole} ${resolution.code} has no active portal account`,
  };
}

for (const [resolverKey, stageRole] of [
  ['TL_OF_SM', 'TL'],
  ['ACM_OF_SM', 'ACM'],
] as const) {
  registerStageResolver(resolverKey, {
    resolve: async (ctx, tx) => {
      const side = smIdForSide(ctx.stage.resolverConfig.smSide, ctx.request);
      if ('missing' in side) return { kind: 'UNRESOLVED', reason: side.missing };

      const resolution = await resolveApprover(stageRole, side.smId, tx);
      return describe(stageRole, side.smId, resolution);
    },
  });
}
