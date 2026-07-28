import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionEvent, correctionRequest, salesRecord } from '@/db/schema';
import { AGE_BUCKETS, bucketForDate } from '@/lib/dashboard/ageing';
import { getApproverDashboard } from '@/lib/dashboard/approver';
import { ageInDays } from '@/lib/format';
import { makeUser, truncateAll } from '../helpers/db';

const DAY = 86_400_000;
const SM_ID = 'C2CM00001';

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY);
}

describe('approver dashboard ageing and throughput (spec 9)', () => {
  let rep: Awaited<ReturnType<typeof makeUser>>;
  let verifier: Awaited<ReturnType<typeof makeUser>>;
  let approver: Awaited<ReturnType<typeof makeUser>>;

  /**
   * Seeds one request per age, each on its own sales record.
   *
   * One record per request is not tidiness: `correction_one_open_per_field`
   * covers PENDING, VERIFIED and RETURNED, so a second live claim against a
   * record already used here would be refused by the database rather than
   * counted by the dashboard.
   */
  async function seedRequests(ages: number[], status: 'PENDING' | 'VERIFIED', appsPrefix: string) {
    const records = await db
      .insert(salesRecord)
      .values(
        ages.map((_, index) => ({
          appsNo: `${appsPrefix}${index}`,
          smId: SM_ID,
          status: 'ISSUED',
          issuedDate: '2026-06-03',
          policyNo: `${appsPrefix}${index}`,
          autopay: null,
        })),
      )
      .returning();

    await db.insert(correctionRequest).values(
      ages.map((age, index) => ({
        recordId: records[index].id,
        appsNo: records[index].appsNo,
        category: 'AUTOPAY' as const,
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: rep.id,
        smId: SM_ID,
        status,
        submittedAt: daysAgo(age),
        // Verified within the last half-day however long the request waited.
        // Deliberately far from `submittedAt`: ageing measures how long the rep
        // has been waiting, so a fixture where the two timestamps agreed could
        // not tell the two clocks apart and would pass either way.
        ...(status === 'VERIFIED'
          ? { verifiedBy: verifier.id, verifiedAt: daysAgo(Math.min(age, 0.5)) }
          : {}),
      })),
    );
  }

  beforeEach(async () => {
    await truncateAll();

    rep = await makeUser({ role: 'sales', smId: SM_ID, email: 'rep@example.test' });
    verifier = await makeUser({ role: 'verifier', email: 'verifier@example.test' });
    approver = await makeUser({ role: 'approver', email: 'approver@example.test' });

    // Ages chosen to land two in each band plus a boundary case on each edge.
    // Seeded VERIFIED, not PENDING: since the 2026-07-28 gate a request only
    // reaches an approver once a verifier has passed it.
    await seedRequests([0, 2, 2.9, 3, 7, 7.9, 8, 30], 'VERIFIED', '640000000');
  });

  it('reports queue depth and the oldest request waiting', async () => {
    const { queue } = await getApproverDashboard();

    expect(queue.pending).toBe(8);
    expect(queue.awaitingVerification).toBe(0);
    expect(queue.oldestPendingAt).toBeInstanceOf(Date);
    expect(ageInDays(queue.oldestPendingAt!)).toBe(30);
  });

  it('buckets ageing exactly as the pure helper does, and the bands sum to the depth', async () => {
    const { queue } = await getApproverDashboard();

    const rows = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.status, 'VERIFIED'));
    const expected: Record<string, number> = { FRESH: 0, AGEING: 0, STALE: 0 };
    for (const row of rows) expected[bucketForDate(row.submittedAt)] += 1;

    for (const bucket of AGE_BUCKETS) {
      expect(queue.ageing[bucket.id], bucket.id).toBe(expected[bucket.id]);
    }

    expect(queue.ageing.FRESH).toBe(3);
    expect(queue.ageing.AGEING).toBe(3);
    expect(queue.ageing.STALE).toBe(2);
    expect(Object.values(queue.ageing).reduce((a, b) => a + b, 0)).toBe(queue.pending);
  });

  it('counts a returned request as waiting on the rep, not as queue depth', async () => {
    const [first] = await db.select().from(correctionRequest).limit(1);
    await db
      .update(correctionRequest)
      .set({ status: 'RETURNED', reviewedBy: approver.id, reviewedAt: new Date() })
      .where(eq(correctionRequest.id, first.id));

    const { queue } = await getApproverDashboard();
    expect(queue.pending).toBe(7);
    expect(queue.returned).toBe(1);
    expect(Object.values(queue.ageing).reduce((a, b) => a + b, 0)).toBe(7);
  });

  it("counts VERIFIED as the approver's depth and PENDING as awaiting verification", async () => {
    // Spread across all three bands and reaching further back than anything the
    // approver holds. Queue depth an approver cannot act on is worse than no
    // number at all — they would be measured on a backlog that is not theirs —
    // so if PENDING ever leaks back into the depth, every band moves here, not
    // just the total.
    await seedRequests([1, 5, 60], 'PENDING', '641000000');

    const { queue } = await getApproverDashboard();

    expect(queue.pending).toBe(8);
    expect(queue.awaitingVerification).toBe(3);

    expect(queue.ageing).toEqual({ FRESH: 3, AGEING: 3, STALE: 2 });
    expect(Object.values(queue.ageing).reduce((a, b) => a + b, 0)).toBe(queue.pending);

    // The 60-day PENDING row is the oldest thing in the table by a wide margin,
    // but it is the verifier's backlog; "oldest waiting" must stay at 30.
    expect(ageInDays(queue.oldestPendingAt!)).toBe(30);
  });

  it('reads throughput from the decision timeline, split by decision and window', async () => {
    const rows = await db.select().from(correctionRequest);

    await db.insert(correctionEvent).values([
      // Today.
      decision(rows[0].id, 'APPROVED', approver.id, 0.1),
      decision(rows[1].id, 'APPROVED', approver.id, 0.5),
      decision(rows[2].id, 'REJECTED', approver.id, 0.2),
      // Earlier this week.
      decision(rows[3].id, 'APPROVED', approver.id, 4),
      decision(rows[4].id, 'RETURNED', approver.id, 5),
      // This month, but not this week.
      decision(rows[5].id, 'APPROVED', approver.id, 12),
      // Outside every window.
      decision(rows[6].id, 'APPROVED', approver.id, 45),
      // Not a decision: the rep's own actions must not count as throughput.
      decision(rows[7].id, 'SUBMITTED', rep.id, 0.3),
      decision(rows[7].id, 'RESUBMITTED', rep.id, 0.2),
    ]);

    const { throughput } = await getApproverDashboard();

    expect(throughput.DAY).toEqual({ APPROVED: 2, REJECTED: 1, RETURNED: 0, TOTAL: 3 });
    expect(throughput.WEEK).toEqual({ APPROVED: 3, REJECTED: 1, RETURNED: 1, TOTAL: 5 });
    expect(throughput.MONTH).toEqual({ APPROVED: 4, REJECTED: 1, RETURNED: 1, TOTAL: 6 });
  });

  it('reports an empty queue rather than failing when nothing is pending', async () => {
    await truncateAll();
    const { queue, throughput } = await getApproverDashboard();

    expect(queue.pending).toBe(0);
    expect(queue.awaitingVerification).toBe(0);
    expect(queue.oldestPendingAt).toBeNull();
    expect(queue.ageing).toEqual({ FRESH: 0, AGEING: 0, STALE: 0 });
    expect(throughput.WEEK.TOTAL).toBe(0);
  });
});

function decision(
  requestId: string,
  action: 'APPROVED' | 'REJECTED' | 'RETURNED' | 'SUBMITTED' | 'RESUBMITTED',
  actorId: string,
  ageDays: number,
) {
  return { requestId, action, actorId, createdAt: daysAgo(ageDays) };
}
