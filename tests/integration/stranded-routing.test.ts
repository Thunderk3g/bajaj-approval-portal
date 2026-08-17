import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, correctionRequestStage, manpower, salesRecord } from '@/db/schema';
import { getRequestDetail } from '@/lib/approvals/queries';
import { retryStageRouting } from '@/lib/workflows';
import { getChain, setChainStages } from '@/lib/workflows/chains';
import { makeUser, sessionFor, truncateAll, installChain } from '../helpers/db';

/**
 * Two defects a team leader hit on the same request, on the same afternoon.
 *
 * Both are about a mapping CLAIM, and that is not a coincidence: a claim is the
 * one request raised against a record the raiser does not own, so it is the case
 * every ownership-shaped assumption gets wrong.
 */

const TL_CODE = 'TL263526';
const ACM_CODE = 'ACM112224';
const REP = 'ICCSP100881';

async function seedClaim() {
  await db.insert(manpower).values([
    { smId: REP, smName: 'Omkar Pawar', tlId: TL_CODE, ccmId: ACM_CODE },
    { smId: 'DIY', smName: 'DIY', tlId: 'DIY', ccmId: 'DIY' },
  ]);

  const tl = await makeUser({ role: 'tl', tlCode: TL_CODE, name: 'Mansi Swaraj' });

  // The record belongs to the DIY bucket — in nobody's team, which is the whole
  // point of a claim and the reason record-shaped scoping fails on it.
  const [record] = await db
    .insert(salesRecord)
    .values({ appsNo: '6167639262', smId: 'DIY', clientName: 'Rohit Kumar Singh', status: 'ISSUED' })
    .returning();

  const [request] = await db
    .insert(correctionRequest)
    .values({
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      fieldName: 'smId',
      fieldLabel: 'SM ID',
      originalValue: 'DIY',
      proposedValue: REP,
      submittedBy: tl.id,
      // The rep the claim is FOR — in this manager's team, unlike the record.
      smId: REP,
      chainKey: 'MAPPING_DIY',
      totalStages: 2,
    })
    .returning();

  return { tl, record, request };
}

describe('reading a claim you raised', () => {
  beforeEach(truncateAll);

  it('lets the manager who raised it open it, though the record is in nobody s team', async () => {
    const { tl, request } = await seedClaim();

    // Scoping this by the RECORD returned null here, and the team leader was
    // shown "that page was not found" for a request they had filed minutes
    // earlier — the record's owner is `DIY`, which no manager scope contains.
    const detail = await getRequestDetail(sessionFor(tl), request.id);

    expect(detail).not.toBeNull();
    expect(detail!.request.appsNo).toBe('6167639262');
  });

  it('still refuses a manager from another cluster', async () => {
    const { request } = await seedClaim();
    const outsider = await makeUser({ role: 'tl', tlCode: 'SOMEBODY-ELSE' });

    // The property the viewer argument was added for in the first place, and
    // which the fix above must not have widened away: request ids are guessable
    // UUIDs and the payload carries the customer, the premium and every remark.
    expect(await getRequestDetail(sessionFor(outsider), request.id)).toBeNull();
  });

  it('lets a manager read a claim somebody else raised against their own rep', async () => {
    const { request } = await seedClaim();
    const acm = await makeUser({ role: 'acm', acmCode: ACM_CODE });

    // Not the raiser, and the record is DIY — reachable only because the request
    // CONCERNS a rep beneath them, which is the arm that models what a manager
    // is answerable for.
    expect(await getRequestDetail(sessionFor(acm), request.id)).not.toBeNull();
  });
});

describe('a rung that resolved to nobody', () => {
  beforeEach(truncateAll);

  /** The shipped `MAPPING_DIY` shape: a named-person step with nobody named. */
  async function openUnroutableStage(requestId: string) {
    await installChain('MAPPING_DIY', [
      { stageKey: 'V2', resolverKey: 'USER', resolverConfig: {}, canReject: false },
      { stageKey: 'APPROVER', resolverKey: 'ROLE', resolverConfig: { role: 'approver' }, canReject: true },
    ]);

    await db.insert(correctionRequestStage).values([
      {
        requestId,
        sequence: 0,
        stageKey: 'V2',
        resolverKey: 'USER',
        resolverConfig: {},
        canReject: false,
        status: 'ACTIVE',
      },
      {
        requestId,
        sequence: 1,
        stageKey: 'APPROVER',
        resolverKey: 'ROLE',
        resolverConfig: { role: 'approver' },
        canReject: true,
        status: 'PENDING',
      },
    ]);
  }

  it('routes to the person named on the chain afterwards, instead of dangling', async () => {
    const { request } = await seedClaim();
    await openUnroutableStage(request.id);

    // Nothing to route to yet — the state every request on the seeded DIY chain
    // was stuck in, with no way anywhere in the product to move it.
    const before = await retryStageRouting(request.id);
    expect(before?.routed).toBe(false);

    const verifier = await makeUser({ role: 'verifier', name: 'QA Verifier' });
    const chain = await getChain('MAPPING_DIY');
    await db.transaction((tx) =>
      setChainStages(tx, chain!.id, [
        {
          stageKey: 'V2',
          resolverKey: 'USER',
          resolverConfig: { userId: verifier.id },
          canReject: false,
        },
        {
          stageKey: 'APPROVER',
          resolverKey: 'ROLE',
          resolverConfig: { role: 'approver' },
          canReject: true,
        },
      ]),
    );

    const after = await retryStageRouting(request.id);
    expect(after?.routed).toBe(true);

    const [stage] = await db
      .select()
      .from(correctionRequestStage)
      .where(eq(correctionRequestStage.requestId, request.id))
      .orderBy(correctionRequestStage.sequence);

    expect(stage.assignedUserId).toBe(verifier.id);
    expect(stage.status).toBe('ACTIVE');
  });

  it('never disturbs a rung that already resolved to somebody', async () => {
    const { request } = await seedClaim();
    const first = await makeUser({ role: 'verifier', name: 'First Verifier' });

    await db.insert(correctionRequestStage).values({
      requestId: request.id,
      sequence: 0,
      stageKey: 'V2',
      resolverKey: 'USER',
      resolverConfig: { userId: first.id },
      canReject: false,
      status: 'ACTIVE',
      assignedUserId: first.id,
    });

    // The freeze this whole mechanism is carved out of: a chain edited while a
    // request sits on a rung must not move that request to somebody else.
    const chain = await getChain('MAPPING_DIY');
    const second = await makeUser({ role: 'verifier', name: 'Second Verifier' });
    await db.transaction((tx) =>
      setChainStages(tx, chain!.id, [
        {
          stageKey: 'V2',
          resolverKey: 'USER',
          resolverConfig: { userId: second.id },
          canReject: false,
        },
        {
          stageKey: 'APPROVER',
          resolverKey: 'ROLE',
          resolverConfig: { role: 'approver' },
          canReject: true,
        },
      ]),
    );

    await retryStageRouting(request.id);

    const [stage] = await db
      .select()
      .from(correctionRequestStage)
      .where(eq(correctionRequestStage.requestId, request.id));

    expect(stage.assignedUserId).toBe(first.id);
  });
});
