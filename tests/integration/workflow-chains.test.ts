import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionRequest,
  correctionRequestStage,
  manpower,
  salesRecord,
} from '@/db/schema';
// From the package front door, never from `engine` directly: the index is what
// registers TL_OF_SM and ACM_OF_SM, so importing the engine alone gives a chain
// whose manager rungs resolve to nobody — which passes as "roster gap" and hides
// the real bug.
import {
  chainKeyFor,
  counterpartySmIdFor,
  decideStage,
  DESIGNED_CHAINS,
  getChain,
  materializeStages,
  setChainStages,
} from '@/lib/workflows';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The chains the business actually asked for — 2026-08-06 spec section 6.
 *
 * Every other suite runs against the two-stage bootstrap chain, which is what
 * proves the engine did not change the old behaviour. This one is the opposite
 * check: that a chain longer than two works, that it stops at every rung, and
 * that the rungs resolve to the people the roster names rather than to whoever
 * happens to hold a role.
 */

const OWNER = 'SM001';
const OTHER = 'SM002';

/**
 * Installs the designed chains, filling every named review position.
 *
 * V1…V5 are people, not pools, so a seeded chain has them empty and every one
 * falls to the administrators until somebody is assigned. `assignments` is what
 * an admin does on the chain screen; passing none is how the unstaffed case is
 * tested.
 */
async function installDesignedChains(assignments: Record<string, string> = {}) {
  for (const [chainKey, stages] of Object.entries(DESIGNED_CHAINS)) {
    const chain = await getChain(chainKey as never);
    if (!chain) continue;

    const staffed = stages.map((stage) =>
      stage.resolverKey === 'USER' && assignments[stage.stageKey]
        ? { ...stage, resolverConfig: { userId: assignments[stage.stageKey] } }
        : stage,
    );

    await db.transaction((tx) => setChainStages(tx, chain.id, staffed));
  }
}

async function roster() {
  await db.insert(manpower).values([
    { smId: OWNER, smName: 'Rep One', tlId: 'TL001', ccmId: 'CCM001', location: 'Pune', isOrphan: false },
    // A different team, under a different ACM — this is what makes a mapping
    // request "between teams" rather than "within one".
    { smId: OTHER, smName: 'Rep Two', tlId: 'TL002', ccmId: 'CCM002', location: 'Nagpur', isOrphan: false },
  ]);
}

async function makeRecord(smId = OWNER) {
  const [record] = await db
    .insert(salesRecord)
    .values({ appsNo: `A-${smId}-${Math.random().toString(36).slice(2, 8)}`, smId, autopay: 'No' })
    .returning();
  return record;
}

async function makeRequest(
  recordId: string,
  appsNo: string,
  submittedBy: string,
  overrides: Partial<typeof correctionRequest.$inferInsert> = {},
) {
  const [row] = await db
    .insert(correctionRequest)
    .values({
      recordId,
      appsNo,
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      originalValue: 'No',
      proposedValue: 'Yes',
      submittedBy,
      smId: OWNER,
      status: 'PENDING',
      ...overrides,
    })
    .returning();
  return row;
}

function stagesOf(requestId: string) {
  return db
    .select()
    .from(correctionRequestStage)
    .where(eq(correctionRequestStage.requestId, requestId))
    .orderBy(asc(correctionRequestStage.sequence));
}

describe('the designed approval chains', () => {
  beforeEach(async () => {
    await truncateAll();
    // The designed chains, unstaffed. `truncateAll` seeds the two-stage bootstrap
    // ones, so without this a test that never calls `staffed()` would silently
    // run against verifier→approver and assert nothing it meant to.
    await installDesignedChains();
    await roster();
  });

  /** Creates the reviewers and staffs every position with them. */
  async function staffed() {
    const v1 = await makeUser({ role: 'verifier', smId: null });
    const v2 = await makeUser({ role: 'verifier', smId: null });
    const v3 = await makeUser({ role: 'verifier', smId: null });
    await installDesignedChains({
      V1: v1.id,
      V2: v2.id,
      V3: v1.id,
      V4: v2.id,
      'V5 (QA)': v3.id,
    });
    return { v1, v2, v3 };
  }

  it('routes a mapping request within one team through TL, ACM, V2 and the approver', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const tl = await makeUser({ role: 'tl', smId: null, tlCode: 'TL001' });
    const acm = await makeUser({ role: 'acm', smId: null, acmCode: 'CCM001' });
    const { v2: verifier } = await staffed();
    const approver = await makeUser({ role: 'approver', smId: null });

    // Both reps under TL001, so the counterparty is in the same team.
    await db.update(manpower).set({ tlId: 'TL001', ccmId: 'CCM001' }).where(eq(manpower.smId, OTHER));

    const record = await makeRecord(OTHER);
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      fieldName: 'smId',
      fieldLabel: 'SM ID',
      originalValue: OTHER,
      proposedValue: OWNER,
      counterpartySmId: OTHER,
    });

    const chainKey = await db.transaction((tx) =>
      chainKeyFor(tx, {
        category: 'MAPPING',
        direction: 'CLAIM_IN',
        submitterSmId: OWNER,
        counterpartySmId: OTHER,
      }),
    );
    expect(chainKey).toBe('MAPPING_WITHIN_TEAM');

    await db.transaction((tx) => materializeStages(tx, request.id, chainKey));
    expect((await stagesOf(request.id)).map((s) => s.stageKey)).toEqual([
      'TL',
      'ACM',
      'V2',
      'APPROVER',
    ]);

    // The TL rung is assigned to the ONE team leader the roster names, not to
    // everybody holding the role.
    const [first] = await stagesOf(request.id);
    expect(first.status).toBe('ACTIVE');
    expect(first.assignedUserId).toBe(tl.id);

    // A verifier cannot jump the queue and take the TL's rung.
    await expect(
      decideStage({ requestId: request.id, actor: verifier, decision: 'ADVANCE' }),
    ).rejects.toThrow(/not been verified yet|not yours/i);

    await decideStage({ requestId: request.id, actor: tl, decision: 'ADVANCE' });
    await decideStage({ requestId: request.id, actor: acm, decision: 'ADVANCE' });
    await decideStage({ requestId: request.id, actor: verifier, decision: 'ADVANCE' });

    const beforeFinal = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, request.id));
    // Three rungs down, still VERIFIED — the status says "past the first gate",
    // not "with the approver", which is what makes it work for a chain of four.
    expect(beforeFinal[0].status).toBe('VERIFIED');
    expect(beforeFinal[0].currentStageSequence).toBe(3);

    const outcome = await decideStage({
      requestId: request.id,
      actor: approver,
      decision: 'ADVANCE',
    });

    expect(outcome.kind).toBe('APPLIED');
    const [applied] = await db.select().from(salesRecord).where(eq(salesRecord.id, record.id));
    expect(applied.smId).toBe(OWNER);
  });

  it('asks the other team’s ACM only after the verifier, on a between-teams mapping', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const tl = await makeUser({ role: 'tl', smId: null, tlCode: 'TL001' });
    const acmOwn = await makeUser({ role: 'acm', smId: null, acmCode: 'CCM001' });
    const acmOther = await makeUser({ role: 'acm', smId: null, acmCode: 'CCM002' });
    const { v2: verifier } = await staffed();
    const approver = await makeUser({ role: 'approver', smId: null });

    const record = await makeRecord(OTHER);
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      fieldName: 'smId',
      fieldLabel: 'SM ID',
      originalValue: OTHER,
      proposedValue: OWNER,
      counterpartySmId: OTHER,
    });

    await db.transaction((tx) => materializeStages(tx, request.id, 'MAPPING_BETWEEN_TEAMS'));

    expect((await stagesOf(request.id)).map((s) => s.stageKey)).toEqual([
      'TL',
      'ACM',
      'V2',
      'ACM (other team)',
      'APPROVER',
    ]);

    await decideStage({ requestId: request.id, actor: tl, decision: 'ADVANCE' });
    await decideStage({ requestId: request.id, actor: acmOwn, decision: 'ADVANCE' });

    // The other team's ACM must NOT be able to act before the verifier has.
    await expect(
      decideStage({ requestId: request.id, actor: acmOther, decision: 'ADVANCE' }),
    ).rejects.toThrow(/not yours/i);

    await decideStage({ requestId: request.id, actor: verifier, decision: 'ADVANCE' });

    const stages = await stagesOf(request.id);
    expect(stages[3].status).toBe('ACTIVE');
    expect(stages[3].assignedUserId).toBe(acmOther.id);
    // And the submitter's own ACM cannot take the counterparty's rung either.
    await expect(
      decideStage({ requestId: request.id, actor: acmOwn, decision: 'ADVANCE' }),
    ).rejects.toThrow(/not yours/i);

    await decideStage({ requestId: request.id, actor: acmOther, decision: 'ADVANCE' });
    const outcome = await decideStage({ requestId: request.id, actor: approver, decision: 'ADVANCE' });
    expect(outcome.kind).toBe('APPLIED');
  });

  it('classifies a claim on an unrostered rep as DIY, with no manager rungs', async () => {
    const chainKey = await db.transaction((tx) =>
      chainKeyFor(tx, {
        category: 'MAPPING',
        direction: 'CLAIM_IN',
        submitterSmId: OWNER,
        counterpartySmId: 'NOBODY999',
      }),
    );

    expect(chainKey).toBe('MAPPING_DIY');
    expect(DESIGNED_CHAINS.MAPPING_DIY.map((s) => s.stageKey)).toEqual(['V2', 'APPROVER']);
  });

  /**
   * V1 and V2 are people the admin assigns, not a pool.
   *
   * The consequence worth testing is that each position admits exactly the person
   * holding it — V1's reviewer cannot clear V2's step just because they are also
   * a verifier, which is precisely what a role pool would have allowed.
   */
  it('sends each review position to the person assigned to it, and nobody else', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const { v1, v2 } = await staffed();
    const approver = await makeUser({ role: 'approver', smId: null });

    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      category: 'ISSUANCE_DATE',
      fieldName: 'issuedDate',
      fieldLabel: 'Issued date',
      originalValue: null,
      proposedValue: '2026-03-01',
    });

    await db.transaction((tx) => materializeStages(tx, request.id, 'ISSUANCE_DATE'));

    const [first] = await stagesOf(request.id);
    expect(first.stageKey).toBe('V1');
    expect(first.assignedUserId).toBe(v1.id);

    // V2's reviewer cannot take V1's step, though both hold the verifier role.
    await expect(
      decideStage({ requestId: request.id, actor: v2, decision: 'ADVANCE' }),
    ).rejects.toThrow(/not yours/i);

    await decideStage({ requestId: request.id, actor: v1, decision: 'ADVANCE' });

    // And having cleared V1, that same person cannot also clear V2.
    await expect(
      decideStage({ requestId: request.id, actor: v1, decision: 'ADVANCE' }),
    ).rejects.toThrow(/not yours/i);

    await decideStage({ requestId: request.id, actor: v2, decision: 'ADVANCE' });
    const outcome = await decideStage({ requestId: request.id, actor: approver, decision: 'ADVANCE' });
    expect(outcome.kind).toBe('APPLIED');
  });

  it('falls to the administrators when a review position has nobody assigned', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const admin = await makeUser({ role: 'admin', smId: null });
    await installDesignedChains(); // nobody staffed

    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      category: 'ISSUANCE_DATE',
      fieldName: 'issuedDate',
      fieldLabel: 'Issued date',
      originalValue: null,
      proposedValue: '2026-03-01',
    });

    const opened = await db.transaction((tx) =>
      materializeStages(tx, request.id, 'ISSUANCE_DATE'),
    );

    expect(opened.warnings.join(' ')).toMatch(/nobody assigned/i);
    await expect(
      decideStage({ requestId: request.id, actor: admin, decision: 'ADVANCE' }),
    ).resolves.toMatchObject({ kind: 'ADVANCED' });
  });

  it('sends a return from any rung back to the submitter and restarts the chain', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const tl = await makeUser({ role: 'tl', smId: null, tlCode: 'TL001' });
    const acm = await makeUser({ role: 'acm', smId: null, acmCode: 'CCM001' });

    await db.update(manpower).set({ tlId: 'TL001', ccmId: 'CCM001' }).where(eq(manpower.smId, OTHER));

    const record = await makeRecord(OTHER);
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      fieldName: 'smId',
      fieldLabel: 'SM ID',
      originalValue: OTHER,
      proposedValue: OWNER,
      counterpartySmId: OTHER,
    });

    await db.transaction((tx) => materializeStages(tx, request.id, 'MAPPING_WITHIN_TEAM'));
    await decideStage({ requestId: request.id, actor: tl, decision: 'ADVANCE' });

    await decideStage({
      requestId: request.id,
      actor: acm,
      decision: 'RETURN',
      remarks: 'Attach the mandate.',
    });

    const [returned] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, request.id));
    expect(returned.status).toBe('RETURNED');

    // Only the LAST rung may reject outright; the ACM in the middle cannot.
    const stages = await stagesOf(request.id);
    expect(stages.map((s) => s.canReject)).toEqual([false, false, false, true]);
  });

  it('opens a rung that resolves to nobody rather than stranding the request', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const admin = await makeUser({ role: 'admin', smId: null });

    // A rep the roster places under nobody: the TL and ACM rungs cannot resolve.
    await db.insert(manpower).values({ smId: 'SM999', isOrphan: true });

    const record = await makeRecord('SM999');
    const request = await makeRequest(record.id, record.appsNo, rep.id, {
      smId: 'SM999',
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      fieldName: 'smId',
      fieldLabel: 'SM ID',
      originalValue: 'SM999',
      proposedValue: OWNER,
      counterpartySmId: 'SM999',
    });

    const opened = await db.transaction((tx) =>
      materializeStages(tx, request.id, 'MAPPING_WITHIN_TEAM'),
    );

    // The request moves, the gap is reported, and an admin can clear the rung.
    expect(opened.warnings.join(' ')).toMatch(/could not be routed/i);
    const [first] = await stagesOf(request.id);
    expect(first.status).toBe('ACTIVE');
    expect(first.assignedUserId).toBeNull();

    await expect(
      decideStage({ requestId: request.id, actor: admin, decision: 'ADVANCE' }),
    ).resolves.toMatchObject({ kind: 'ADVANCED' });
  });

  it('does not disturb a request already in flight when the chain is edited', async () => {
    const rep = await makeUser({ role: 'sales', smId: OWNER });
    const { v1: verifier } = await staffed();
    const approver = await makeUser({ role: 'approver', smId: null });

    const record = await makeRecord();
    const request = await makeRequest(record.id, record.appsNo, rep.id);

    await db.transaction((tx) => materializeStages(tx, request.id, 'AUTOPAY'));
    expect((await stagesOf(request.id)).map((s) => s.stageKey)).toEqual(['V1', 'APPROVER']);

    // An admin rewrites the chain to something much longer, mid-flight.
    const chain = await getChain('AUTOPAY');
    await db.transaction((tx) =>
      setChainStages(tx, chain!.id, [
        { stageKey: 'TL', resolverKey: 'TL_OF_SM', resolverConfig: { smSide: 'SUBMITTER' } },
        { stageKey: 'V1', resolverKey: 'ROLE', resolverConfig: { role: 'verifier' } },
        { stageKey: 'V2', resolverKey: 'ROLE', resolverConfig: { role: 'verifier' } },
        { stageKey: 'APPROVER', resolverKey: 'ROLE', resolverConfig: { role: 'approver' }, canReject: true },
      ]),
    );

    // The in-flight request still has its own two rungs and finishes on them.
    expect((await stagesOf(request.id)).map((s) => s.stageKey)).toEqual(['V1', 'APPROVER']);
    await decideStage({ requestId: request.id, actor: verifier, decision: 'ADVANCE' });
    const outcome = await decideStage({ requestId: request.id, actor: approver, decision: 'ADVANCE' });
    expect(outcome.kind).toBe('APPLIED');
  });

  it('reads the counterparty from the direction, not from the record', () => {
    expect(
      counterpartySmIdFor({ direction: 'CLAIM_IN', recordSmId: OTHER, proposedSmId: OWNER }),
    ).toBe(OTHER);
    expect(
      counterpartySmIdFor({ direction: 'TRANSFER_OUT', recordSmId: OWNER, proposedSmId: OTHER }),
    ).toBe(OTHER);
    expect(
      counterpartySmIdFor({ direction: null, recordSmId: OWNER, proposedSmId: null }),
    ).toBeNull();
  });
});
