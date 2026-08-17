import { beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequest, correctionRequestStage, manpower, salesRecord } from '@/db/schema';
import { getRequestDetail } from '@/lib/approvals/queries';
import { listActionableForUser, reassignOpenStages } from '@/lib/workflows';
import { makeUser, sessionFor, truncateAll } from '../helpers/db';

/**
 * The team leader who is a REVIEWER on somebody else's request.
 *
 * Five categories — AutoPay, DIY changes, SM ID changes, issuance dates and
 * "other fields" — run chains whose review positions are filled by a NAMED
 * person, and the business staffs those positions with team leaders. That team
 * leader is not the rep's own: they did not raise the request, the rep is in
 * another cluster, and the record is in nobody's book. Every ownership-shaped
 * read predicate therefore refused them, and the request sitting at the top of
 * their own approvals queue opened as "page not found".
 *
 * AutoPay stands in for all five here: the shape that breaks is the `USER` rung,
 * and the five chains differ only in how many of them they have.
 */

const REP = 'ICCSP900211';
const REP_TL = 'TL900001';
const REP_ACM = 'CCM900001';
/** The reviewer's own code — a different cluster, which is the whole point. */
const REVIEWER_TL = 'TL900002';

async function seedAutopayAtV1() {
  await db.insert(manpower).values([
    { smId: REP, smName: 'Anita Desai', tlId: REP_TL, ccmId: REP_ACM },
  ]);

  const rep = await makeUser({ role: 'sales', smId: REP, name: 'Anita Desai' });
  const reviewer = await makeUser({ role: 'tl', tlCode: REVIEWER_TL, name: 'V1 Reviewer' });

  const [record] = await db
    .insert(salesRecord)
    .values({ appsNo: '7100240031', smId: REP, clientName: 'Sunil Gupta', status: 'ISSUED' })
    .returning();

  const [request] = await db
    .insert(correctionRequest)
    .values({
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'AUTOPAY',
      fieldName: 'autopayStatus',
      fieldLabel: 'AutoPay status',
      originalValue: 'N',
      proposedValue: 'Y',
      submittedBy: rep.id,
      smId: REP,
      chainKey: 'AUTOPAY',
      totalStages: 2,
    })
    .returning();

  await db.insert(correctionRequestStage).values([
    {
      requestId: request.id,
      sequence: 0,
      stageKey: 'V1',
      resolverKey: 'USER',
      resolverConfig: { userId: reviewer.id },
      canReject: false,
      status: 'ACTIVE',
      assignedUserId: reviewer.id,
    },
    {
      requestId: request.id,
      sequence: 1,
      stageKey: 'APPROVER',
      resolverKey: 'ROLE',
      resolverConfig: { role: 'approver' },
      canReject: true,
      status: 'PENDING',
    },
  ]);

  return { rep, reviewer, record, request };
}

describe('a request routed to a named reviewer', () => {
  beforeEach(truncateAll);

  it('opens for the team leader the rung is assigned to', async () => {
    const { reviewer, request } = await seedAutopayAtV1();

    // The queue already listed this row — `listActionableForUser` matches on the
    // stage assignment — and clicking it answered "not found", because the read
    // predicate asked about ownership instead.
    const queue = await listActionableForUser(reviewer);
    expect(queue.map((r) => r.requestId)).toEqual([request.id]);

    const detail = await getRequestDetail(sessionFor(reviewer), request.id);
    expect(detail).not.toBeNull();
    expect(detail!.request.appsNo).toBe('7100240031');
  });

  it('still refuses a team leader with no rung on it', async () => {
    const { request } = await seedAutopayAtV1();
    const outsider = await makeUser({ role: 'tl', tlCode: 'TL-SOMEBODY-ELSE' });

    // The property the viewer argument exists for: request ids are guessable
    // UUIDs and the payload carries the customer, the premium and every remark.
    expect(await getRequestDetail(sessionFor(outsider), request.id)).toBeNull();
  });

  it('keeps a rung readable by whoever decided it, after it has moved on', async () => {
    const { reviewer, request } = await seedAutopayAtV1();

    await db
      .update(correctionRequestStage)
      .set({ status: 'PASSED', decidedBy: reviewer.id, assignedUserId: null })
      .where(eq(correctionRequestStage.requestId, request.id));

    // Signed off last week, no longer waiting on them. A reviewer who cannot
    // reopen what they put their name to cannot answer a question about it.
    expect(await getRequestDetail(sessionFor(reviewer), request.id)).not.toBeNull();
  });
});

describe('reassigning a review position that is already in flight', () => {
  beforeEach(truncateAll);

  it('moves the open rung to the new reviewer and off the old one s queue', async () => {
    const { reviewer, request } = await seedAutopayAtV1();
    const successor = await makeUser({ role: 'tl', tlCode: 'TL900003', name: 'New V1' });

    const outcome = await reassignOpenStages('AUTOPAY', [
      { stageKey: 'V1', userId: successor.id },
    ]);

    expect(outcome).toEqual([{ stageKey: 'V1', moved: 1, notified: 1 }]);

    const [stage] = await db
      .select()
      .from(correctionRequestStage)
      .where(eq(correctionRequestStage.requestId, request.id))
      .orderBy(asc(correctionRequestStage.sequence));

    expect(stage.assignedUserId).toBe(successor.id);
    // The stage's OWN copy of the config, not just the queue column: the engine
    // re-resolves the rung from it before accepting a decision, so a half-moved
    // rung would show in the new reviewer's queue and then refuse their click.
    expect(stage.resolverConfig).toEqual({ userId: successor.id });

    expect((await listActionableForUser(successor)).map((r) => r.requestId)).toEqual([request.id]);
    expect(await listActionableForUser(reviewer)).toEqual([]);

    expect(await getRequestDetail(sessionFor(successor), request.id)).not.toBeNull();
    expect(await getRequestDetail(sessionFor(reviewer), request.id)).toBeNull();
  });

  it('never moves a rung somebody has already decided', async () => {
    const { reviewer, request } = await seedAutopayAtV1();
    const successor = await makeUser({ role: 'tl', tlCode: 'TL900003' });

    await db
      .update(correctionRequestStage)
      .set({ status: 'PASSED', decidedBy: reviewer.id })
      .where(eq(correctionRequestStage.stageKey, 'V1'));
    await db
      .update(correctionRequest)
      .set({ status: 'VERIFIED' })
      .where(eq(correctionRequest.id, request.id));

    const outcome = await reassignOpenStages('AUTOPAY', [
      { stageKey: 'V1', userId: successor.id },
    ]);

    expect(outcome).toEqual([]);

    // History stays attributed to the person who made it.
    const [stage] = await db
      .select()
      .from(correctionRequestStage)
      .where(eq(correctionRequestStage.stageKey, 'V1'));

    expect(stage.assignedUserId).toBe(reviewer.id);
    expect(stage.decidedBy).toBe(reviewer.id);
  });
});
