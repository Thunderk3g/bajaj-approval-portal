import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionEvent,
  correctionRequest,
  salesRecord,
  salesRecordVersion,
} from '@/db/schema';
import { ApprovalError, applyApproval, rejectRequest, returnRequest } from '@/lib/approvals/apply';
import { runBulk } from '@/lib/approvals/bulk';
import { returnFromVerification, verifyRequest } from '@/lib/verification/apply';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * Batch decisions — one action over a selection.
 *
 * Every test here is about the SAME claim: one transaction per request, never
 * one around the batch. That claim is only observable when a batch is mixed, so
 * most of these seed a queue that cannot all succeed and then assert on what
 * survived — a suite that only ever batched decidable requests would pass
 * identically against an implementation that wrapped the lot in one transaction
 * and rolled all of it back on the first failure.
 *
 * `runBulk` is exercised with the real domain functions rather than through the
 * Server Actions, matching `corrections-requests.test.ts`: the actions add
 * `requireRole` and a FormData decode, and neither is what makes a batch
 * correct.
 */

const OWNER = 'ICCSP90766';

type Actor = { id: string; email: string; role: 'approver' | 'verifier' };

async function seed(count: number, status: 'PENDING' | 'VERIFIED') {
  const rep = await makeUser({ role: 'sales', smId: OWNER, name: 'Priya Sales' });
  const verifierRow = await makeUser({ role: 'verifier', smId: null, name: 'Vidya Verifier' });
  const approverRow = await makeUser({ role: 'approver', smId: null, name: 'Anand Approver' });

  const verifier: Actor = { id: verifierRow.id, email: verifierRow.email, role: 'verifier' };
  const approver: Actor = { id: approverRow.id, email: approverRow.email, role: 'approver' };

  const requests: string[] = [];
  const records: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const [record] = await db
      .insert(salesRecord)
      .values({
        appsNo: `61675095${String(i).padStart(2, '0')}`,
        smId: OWNER,
        clientName: `Client ${i}`,
        status: 'ISSUED',
      })
      .returning();

    await db.insert(salesRecordVersion).values({
      recordId: record.id,
      version: 1,
      data: record as unknown as Record<string, unknown>,
      changeType: 'IMPORT',
    });

    const [request] = await db
      .insert(correctionRequest)
      .values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: rep.id,
        smId: OWNER,
        status,
        // A VERIFIED row needs its first gate filled in, or the request claims
        // to have passed a review nobody performed.
        ...(status === 'VERIFIED'
          ? { verifiedBy: verifierRow.id, verifiedAt: new Date() }
          : {}),
      })
      .returning();

    requests.push(request.id);
    records.push(record.id);
  }

  return { rep, verifier, approver, requests, records };
}

const statuses = async (ids: string[]) => {
  const rows = await db
    .select({ id: correctionRequest.id, status: correctionRequest.status })
    .from(correctionRequest)
    .where(inArray(correctionRequest.id, ids));
  return new Map(rows.map((r) => [r.id, r.status]));
};

describe('bulk approval', () => {
  beforeEach(truncateAll);

  it('applies every request in the batch and names each one it applied', async () => {
    const { approver, requests, records } = await seed(4, 'VERIFIED');

    const report = await runBulk(requests, (requestId) =>
      applyApproval({ requestId, actor: approver, remarks: 'Batch checked.' }),
    );

    expect(report.succeeded).toEqual(requests);
    expect(report.failed).toEqual([]);

    const after = await statuses(requests);
    expect([...after.values()]).toEqual(['APPROVED', 'APPROVED', 'APPROVED', 'APPROVED']);

    // Each one went the whole way, not just to a status change: the record holds
    // the value and carries a second version. A batch that only moved the
    // request rows would satisfy the assertion above and nothing else.
    const written = await db
      .select()
      .from(salesRecord)
      .where(inArray(salesRecord.id, records));
    expect(written.map((r) => r.autopay)).toEqual(['Yes', 'Yes', 'Yes', 'Yes']);
    expect(written.map((r) => r.currentVersion)).toEqual([2, 2, 2, 2]);
  });

  it('commits the ones that succeed even though one in the middle fails', async () => {
    const { approver, requests, records } = await seed(3, 'VERIFIED');

    // The middle request is dragged back to PENDING, so the verifier gate
    // refuses it. This is the shape the whole design exists for: a real queue
    // has a request somebody else already touched.
    await db
      .update(correctionRequest)
      .set({ status: 'PENDING' })
      .where(eq(correctionRequest.id, requests[1]));

    const report = await runBulk(requests, (requestId) =>
      applyApproval({ requestId, actor: approver }),
    );

    expect(report.succeeded).toEqual([requests[0], requests[2]]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].requestId).toBe(requests[1]);
    // The message has to say WAIT rather than "already decided" — the approver's
    // next move differs completely between the two.
    expect(report.failed[0].message).toMatch(/not been verified/i);

    // The load-bearing assertion. One transaction around the batch would have
    // rolled these two back on the failure, and the approver would be told
    // nothing happened when they had checked all three.
    const after = await statuses(requests);
    expect(after.get(requests[0])).toBe('APPROVED');
    expect(after.get(requests[1])).toBe('PENDING');
    expect(after.get(requests[2])).toBe('APPROVED');

    const written = await db
      .select()
      .from(salesRecord)
      .where(inArray(salesRecord.id, records));
    const byId = new Map(written.map((r) => [r.id, r]));
    expect(byId.get(records[0])!.autopay).toBe('Yes');
    // Untouched, and still on version 1: the refusal left no partial write.
    expect(byId.get(records[1])!.autopay).toBeNull();
    expect(byId.get(records[1])!.currentVersion).toBe(1);
    expect(byId.get(records[2])!.autopay).toBe('Yes');
  });

  it('carries on past an error that is not a domain failure, and still reports it', async () => {
    const { approver, requests } = await seed(3, 'VERIFIED');

    // Not an ApprovalError — the class of thing the single-request actions
    // re-throw. A batch cannot re-throw it: by this point request one has
    // already COMMITTED, and abandoning the run would leave the approver unable
    // to tell an applied correction from a skipped one.
    const report = await runBulk(requests, async (requestId) => {
      if (requestId === requests[1]) throw new TypeError('something unrelated broke');
      return applyApproval({ requestId, actor: approver });
    });

    expect(report.succeeded).toEqual([requests[0], requests[2]]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].requestId).toBe(requests[1]);
    expect(report.failed[0].message).toMatch(/unexpected/i);

    const after = await statuses(requests);
    expect(after.get(requests[0])).toBe('APPROVED');
    expect(after.get(requests[1])).toBe('VERIFIED');
    expect(after.get(requests[2])).toBe('APPROVED');
  });

  it('reports a repeated warning once', async () => {
    const { approver, requests } = await seed(2, 'VERIFIED');

    // Two mapping claims onto the SAME SM_ID that the roster has never heard of.
    // Approving both produces the identical warning twice, and fifty copies of
    // one sentence is how the one warning that differs gets missed.
    const gaining = 'C2CM99999';
    for (const requestId of requests) {
      await db
        .update(correctionRequest)
        .set({
          category: 'MAPPING',
          direction: 'CLAIM_IN',
          fieldName: 'smId',
          fieldLabel: 'SM ID',
          proposedValue: gaining,
        })
        .where(eq(correctionRequest.id, requestId));
    }

    const report = await runBulk(requests, (requestId) =>
      applyApproval({ requestId, actor: approver }),
    );

    expect(report.succeeded).toHaveLength(2);

    const roster = report.warnings.filter((w) => w.includes('Manpower roster'));
    expect(roster).toHaveLength(1);
    expect(roster[0]).toContain(gaining);
  });

  it('keeps a distinct warning from each request', async () => {
    const { approver, requests } = await seed(2, 'VERIFIED');

    const targets = ['C2CM88888', 'C2CM77777'];
    for (const [i, requestId] of requests.entries()) {
      await db
        .update(correctionRequest)
        .set({
          category: 'MAPPING',
          direction: 'CLAIM_IN',
          fieldName: 'smId',
          fieldLabel: 'SM ID',
          proposedValue: targets[i],
        })
        .where(eq(correctionRequest.id, requestId));
    }

    const report = await runBulk(requests, (requestId) =>
      applyApproval({ requestId, actor: approver }),
    );

    // Deduplication is by TEXT, so two different unrostered IDs stay two
    // warnings. Collapsing them by count or by type would hide one of them.
    const rosterWarnings = report.warnings.filter((w) => w.includes('Manpower roster'));
    expect(rosterWarnings).toHaveLength(2);
  });

  it('refuses the whole batch when the actor is not an approver', async () => {
    const { verifier, requests } = await seed(2, 'VERIFIED');

    // `assertMayDecide` runs inside each transaction, so a wrong role fails every
    // request individually rather than being caught once at the edge. The batch
    // path adds no way around it.
    const report = await runBulk(requests, (requestId) =>
      applyApproval({ requestId, actor: verifier }),
    );

    expect(report.succeeded).toEqual([]);
    expect(report.failed).toHaveLength(2);
    expect((await statuses(requests)).get(requests[0])).toBe('VERIFIED');
  });
});

describe('bulk reject and return', () => {
  beforeEach(truncateAll);

  it('rejects a selection without writing to any record', async () => {
    const { approver, requests, records } = await seed(3, 'VERIFIED');

    const report = await runBulk(requests, (requestId) =>
      rejectRequest({ requestId, actor: approver, remarks: 'Proof does not match.' }),
    );

    expect(report.succeeded).toHaveLength(3);
    expect([...(await statuses(requests)).values()]).toEqual([
      'REJECTED',
      'REJECTED',
      'REJECTED',
    ]);

    const untouched = await db.select().from(salesRecord).where(inArray(salesRecord.id, records));
    expect(untouched.every((r) => r.autopay === null && r.currentVersion === 1)).toBe(true);
  });

  it('writes the one shared remark onto every request in the batch', async () => {
    const { approver, requests } = await seed(2, 'VERIFIED');
    const remark = 'Attach the mandate PDF — the screenshot is unreadable.';

    await runBulk(requests, (requestId) =>
      returnRequest({ requestId, actor: approver, remarks: remark }),
    );

    const rows = await db
      .select()
      .from(correctionRequest)
      .where(inArray(correctionRequest.id, requests));
    expect(rows.every((r) => r.status === 'RETURNED')).toBe(true);
    expect(rows.every((r) => r.approverRemarks === remark)).toBe(true);

    // The timeline is per request, not per batch: each submitter opens their own
    // request and has to find a decision on it.
    const events = await db
      .select()
      .from(correctionEvent)
      .where(inArray(correctionEvent.requestId, requests));
    expect(events.filter((e) => e.action === 'RETURNED')).toHaveLength(2);
  });

  it('refuses a batch return with no remarks and changes nothing', async () => {
    const { approver, requests } = await seed(2, 'VERIFIED');

    const report = await runBulk(requests, (requestId) =>
      returnRequest({ requestId, actor: approver, remarks: '   ' }),
    );

    expect(report.succeeded).toEqual([]);
    expect(report.failed).toHaveLength(2);
    expect([...(await statuses(requests)).values()]).toEqual(['VERIFIED', 'VERIFIED']);
  });
});

describe('bulk verification', () => {
  beforeEach(truncateAll);

  it('passes a selection to the approvers in one action', async () => {
    const { verifier, requests, records } = await seed(3, 'PENDING');

    const report = await runBulk(requests, (requestId) =>
      verifyRequest({ requestId, actor: verifier }),
    );

    expect(report.succeeded).toEqual(requests);
    expect([...(await statuses(requests)).values()]).toEqual([
      'VERIFIED',
      'VERIFIED',
      'VERIFIED',
    ]);

    // Verification asserts, it does not apply — a batch of it must still leave
    // every record on version 1 with nothing written.
    const untouched = await db.select().from(salesRecord).where(inArray(salesRecord.id, records));
    expect(untouched.every((r) => r.currentVersion === 1 && !r.hasCorrections)).toBe(true);
  });

  it('skips a request another verifier already took, and keeps the rest', async () => {
    const { verifier, requests } = await seed(3, 'PENDING');

    const other = await makeUser({ role: 'verifier', smId: null });
    await verifyRequest({
      requestId: requests[1],
      actor: { id: other.id, email: other.email, role: 'verifier' },
    });

    const report = await runBulk(requests, (requestId) =>
      verifyRequest({ requestId, actor: verifier }),
    );

    expect(report.succeeded).toEqual([requests[0], requests[2]]);
    expect(report.failed[0].message).toMatch(/already passed this request/i);

    // The colleague's verification stands — it is not overwritten by the batch,
    // so the request still names who actually looked at it.
    const stolen = (
      await db.select().from(correctionRequest).where(eq(correctionRequest.id, requests[1]))
    )[0];
    expect(stolen.verifiedBy).toBe(other.id);
  });

  it('returns a selection to the submitters', async () => {
    const { verifier, requests } = await seed(2, 'PENDING');

    const report = await runBulk(requests, (requestId) =>
      returnFromVerification({ requestId, actor: verifier, remarks: 'No proof attached.' }),
    );

    expect(report.succeeded).toHaveLength(2);
    expect([...(await statuses(requests)).values()]).toEqual(['RETURNED', 'RETURNED']);
  });
});

describe('runBulk bookkeeping', () => {
  beforeEach(truncateAll);

  it('preserves the order it decided in', async () => {
    const seen: string[] = [];
    const ids = ['a', 'b', 'c'];

    const report = await runBulk(ids, async (requestId) => {
      seen.push(requestId);
      return {};
    });

    // Sequential, not concurrent. Two requests in one batch can target the same
    // sales_record, and applyApprovalWithin takes FOR UPDATE on it — run
    // concurrently, a batch larger than the connection pool queues against
    // itself.
    expect(seen).toEqual(ids);
    expect(report.succeeded).toEqual(ids);
  });

  it('reports a domain failure by its own message', async () => {
    const report = await runBulk(['a'], async () => {
      throw new ApprovalError('NOT_FOUND', 'That correction request no longer exists.');
    });

    expect(report.succeeded).toEqual([]);
    expect(report.failed).toEqual([
      { requestId: 'a', message: 'That correction request no longer exists.' },
    ]);
  });
});
