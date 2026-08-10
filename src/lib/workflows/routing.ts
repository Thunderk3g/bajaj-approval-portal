import { eq } from 'drizzle-orm';
import { manpower, manpowerOverride } from '@/db/schema';
import type { DbTransaction } from '@/lib/audit/log';
import type { ChainKey, StageDraft } from './chains';

/**
 * Which chain a request runs, and what each chain looks like — 2026-08-06 spec
 * section 6.
 *
 * Separate from the engine on purpose: the engine walks whatever ordered list it
 * is handed and has no concept of a losing side, a location or a team. Everything
 * that does is here, so the business rules can change without touching the state
 * machine, and the state machine can be reasoned about without knowing them.
 */

/* ------------------------------------------------------- counterparty side */

/**
 * The SM_ID on the OTHER side of a mapping request.
 *
 * `CLAIM_IN` — the submitter is gaining, so the counterparty is the record's
 * current owner, who stands to lose the sale. `TRANSFER_OUT` — the submitter is
 * losing, so it is the proposed owner, who stands to receive it. This is the
 * same reading `notifyMappingCounterparty` already uses, restated here because
 * the chain needs it at submission and the notification needs it afterwards.
 *
 * Computed once and frozen on the request (`counterparty_sm_id`), because
 * `record.sm_id` is the very column an approved mapping rewrites: a between-team
 * chain resolving its second ACM days later against a re-read record would
 * resolve against whoever owns it by then, not whoever it was raised against.
 */
export function counterpartySmIdFor(input: {
  direction: 'CLAIM_IN' | 'TRANSFER_OUT' | null;
  recordSmId: string;
  proposedSmId: string | null;
}): string | null {
  if (!input.direction) return null;
  return input.direction === 'CLAIM_IN' ? input.recordSmId : input.proposedSmId;
}

/* ------------------------------------------------------------ hierarchy read */

type Placement = { smId: string; tlId: string | null; ccmId: string | null } | null;

/**
 * The EFFECTIVE placement of one rep: the sheet, with any admin override on top.
 *
 * Duplicated in spirit by `resolveHierarchy`, but deliberately narrow — routing
 * needs two ids and no names, runs inside the submission transaction, and must
 * not depend on the richer lookup's display concerns.
 */
async function placementOf(tx: DbTransaction, smId: string): Promise<Placement> {
  const [row] = await tx
    .select({
      smId: manpower.smId,
      sheetTlId: manpower.tlId,
      sheetCcmId: manpower.ccmId,
      isOrphan: manpower.isOrphan,
      overrideTlId: manpowerOverride.tlId,
      overrideCcmId: manpowerOverride.ccmId,
    })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(eq(manpower.smId, smId))
    .limit(1);

  if (!row) return null;

  const tlId = row.overrideTlId ?? row.sheetTlId;
  const ccmId = row.overrideCcmId ?? row.sheetCcmId;

  // An orphan row is a placeholder the importer created for an SM_ID it saw in
  // transaction data and could not find on the roster. It exists, but it places
  // the rep nowhere — treated as unplaced rather than as a team of one.
  if (row.isOrphan && !tlId && !ccmId) return null;

  return { smId: row.smId, tlId, ccmId };
}

/* --------------------------------------------------------- classification */

export type MappingShape = 'WITHIN_TEAM' | 'BETWEEN_TEAMS' | 'DIY';

/**
 * Which of the three mapping shapes this request is — spec section 6.
 *
 * Derived entirely from data already present; no new column, and no question put
 * to the submitter. Asking would be worse than deriving: the rep raising a claim
 * does not necessarily know whose team the current owner sits in, and a wrong
 * answer would route the request past the manager who should have seen it.
 */
export async function mappingShapeFor(
  tx: DbTransaction,
  submitterSmId: string,
  counterpartySmId: string | null,
): Promise<MappingShape> {
  if (!counterpartySmId) return 'DIY';

  const counterparty = await placementOf(tx, counterpartySmId);

  // Nobody real on the other side — an unowned policy, an orphan code, a rep the
  // roster has never heard of. There is no team to route through, which is
  // exactly the "outside / DIY" case rather than a special one.
  if (!counterparty || !counterparty.tlId) return 'DIY';

  const submitter = await placementOf(tx, submitterSmId);
  if (!submitter || !submitter.tlId) return 'DIY';

  return submitter.tlId === counterparty.tlId ? 'WITHIN_TEAM' : 'BETWEEN_TEAMS';
}

/**
 * The chain a request runs, resolved at submission and then frozen.
 *
 * MAPPING is the only category that fans out, and it fans out on data rather than
 * on anything the submitter chose. Every other category maps one-to-one.
 */
export async function chainKeyFor(
  tx: DbTransaction,
  input: {
    category: string;
    direction: 'CLAIM_IN' | 'TRANSFER_OUT' | null;
    submitterSmId: string;
    counterpartySmId: string | null;
  },
): Promise<ChainKey> {
  if (input.category !== 'MAPPING') {
    return input.category as ChainKey;
  }

  const shape = await mappingShapeFor(tx, input.submitterSmId, input.counterpartySmId);
  if (shape === 'WITHIN_TEAM') return 'MAPPING_WITHIN_TEAM';
  if (shape === 'BETWEEN_TEAMS') return 'MAPPING_BETWEEN_TEAMS';
  return 'MAPPING_DIY';
}

/* ------------------------------------------------------- the chain shapes */

const TL = (side: 'SUBMITTER' | 'COUNTERPARTY'): StageDraft => ({
  stageKey: side === 'SUBMITTER' ? 'TL' : 'TL (other team)',
  resolverKey: 'TL_OF_SM',
  resolverConfig: { smSide: side },
  canReject: false,
});

const ACM = (side: 'SUBMITTER' | 'COUNTERPARTY'): StageDraft => ({
  // "other team", not "other location": the rung is resolved from the
  // counterparty's SM_ID through the roster, not from a location string, and
  // naming it after a location invites somebody to go looking for one.
  stageKey: side === 'SUBMITTER' ? 'ACM' : 'ACM (other team)',
  resolverKey: 'ACM_OF_SM',
  resolverConfig: { smSide: side },
  canReject: false,
});

/**
 * A review position — V1, V2, V3 and so on.
 *
 * Filled by a NAMED person, not by a role pool. The business creates a reviewer,
 * decides they are V2, and expects V2 to mean them; resolving the slot to
 * "anybody holding the verifier role" would send it to all of them at once. The
 * person is usually a team leader or an area manager rather than a dedicated
 * verifier account, which is the other reason a role pool is the wrong shape.
 *
 * Seeded with nobody assigned. An unassigned position resolves to UNRESOLVED and
 * falls to the administrators, which is the honest state for a chain whose desks
 * have not been staffed yet — and it is visible on the chain screen in amber
 * rather than looking finished.
 */
const V = (slot: string): StageDraft => ({
  stageKey: slot,
  resolverKey: 'USER',
  resolverConfig: {},
  canReject: false,
});

const APPROVER: StageDraft = {
  stageKey: 'APPROVER',
  resolverKey: 'ROLE',
  resolverConfig: { role: 'approver' },
  canReject: true,
};

/**
 * The chains as the business described them — spec section 6.
 *
 * Autopay carries no TL rung: the TL is notified when one of their reps raises
 * one, but cannot gate it. That asymmetry against mapping is deliberate and
 * confirmed — a mapping moves a sale between books, an autopay flag does not.
 */
export const DESIGNED_CHAINS: Record<ChainKey, StageDraft[]> = {
  AUTOPAY: [V('V1'), APPROVER],

  MAPPING_WITHIN_TEAM: [TL('SUBMITTER'), ACM('SUBMITTER'), V('V2'), APPROVER],

  // The submitter's own chain closes out first, the verifier is the pivot, and
  // only then is the other team's ACM asked — both sides consent to a sale moving
  // between books, with the receiving side checked last before final approval.
  MAPPING_BETWEEN_TEAMS: [
    TL('SUBMITTER'),
    ACM('SUBMITTER'),
    V('V2'),
    ACM('COUNTERPARTY'),
    APPROVER,
  ],

  // No team to route through, by construction: the counterparty resolved to
  // nobody real, which is what put the request on this chain.
  MAPPING_DIY: [V('V2'), APPROVER],

  // Two review positions, so two different people by construction — they are
  // named, so "two pairs of eyes" is who the admin assigns rather than a rule the
  // engine has to enforce.
  ISSUANCE_DATE: [V('V1'), V('V2'), APPROVER],

  BAU_TO_BFL: [V('V3'), V('V4'), V('V5 (QA)'), APPROVER],

  // Not named in the requirement. Left on the flow they already ran rather than
  // guessed at — spec §9 open question 14.
  OTHERS: [V('V1'), APPROVER],
  AGENT_ID: [V('V1'), APPROVER],
};
