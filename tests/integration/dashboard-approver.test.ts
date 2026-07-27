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
  let approver: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await truncateAll();

    rep = await makeUser({ role: 'sales', smId: SM_ID, email: 'rep@example.test' });
    approver = await makeUser({ role: 'approver', email: 'approver@example.test' });

    const records = await db
      .insert(salesRecord)
      .values(
        Array.from({ length: 8 }, (_, index) => ({
          appsNo: `640000000${index}`,
          smId: SM_ID,
          status: 'ISSUED',
          issuedDate: '2026-06-03',
          policyNo: `950000${index}`,
          autopay: null,
        })),
      )
      .returning();

    // Ages chosen to land two in each band plus a boundary case on each edge.
    const pendingAges = [0, 2, 2.9, 3, 7, 7.9, 8, 30];

    await db.insert(correctionRequest).values(
      pendingAges.map((age, index) => ({
        recordId: records[index].id,
        appsNo: records[index].appsNo,
        category: 'AUTOPAY' as const,
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: rep.id,
        smId: SM_ID,
        status: 'PENDING' as const,
        submittedAt: daysAgo(age),
      })),
    );
  });

  it('reports queue depth and the oldest request waiting', async () => {
    const { queue } = await getApproverDashboard();

    expect(queue.pending).toBe(8);
    expect(queue.oldestPendingAt).toBeInstanceOf(Date);
    expect(ageInDays(queue.oldestPendingAt!)).toBe(30);
  });

  it('buckets ageing exactly as the pure helper does, and the bands sum to the depth', async () => {
    const { queue } = await getApproverDashboard();

    const rows = await db.select().from(correctionRequest);
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
