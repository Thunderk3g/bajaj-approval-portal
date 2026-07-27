import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { lookupRecordByAppsNo } from '@/lib/corrections/lookup';
import { LOOKUP_LIMIT_PER_HOUR } from '@/lib/rate-limit';
import { makeUser, truncateAll } from '../helpers/db';

/**
 * The section 7.2 scoping exception, under test.
 *
 * This is the one place a sales user reads outside their own SM_ID, and the
 * three properties that make it safe — exact match, restricted projection, rate
 * limit — are each asserted here. A change that widens any of them fails a test
 * rather than quietly turning a mapping-claim tool into an enumeration tool.
 */

const APPS_NO = '6167509575';
const OWNER_SM_ID = 'ICCSP90766';
const LOOKER_SM_ID = 'C2CM21350';

/** Exactly the six fields section 7.2 permits. Nothing may be added. */
const PERMITTED_KEYS = [
  'appsNo',
  'clientName',
  'issuedDate',
  'productName',
  'smName',
  'status',
] as const;

function sessionFor(row: { id: string; name: string; email: string; role: string; smId: string | null }): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

async function makeRecord() {
  const [row] = await db
    .insert(salesRecord)
    .values({
      appsNo: APPS_NO,
      smId: OWNER_SM_ID,
      smName: 'Owner Rep',
      clientName: 'Ravi Kumar',
      // Everything below is what the projection must NOT return.
      policyNo: '0123456789',
      fp: '4195.42',
      anp: '50345.00',
      leadId: 'LEAD-99',
      location: 'Pune',
      tlName: 'Team Lead',
      productName: 'Assured Wealth Goal',
      status: 'ISSUED',
      issuedDate: '2026-06-03',
    })
    .returning();
  return row;
}

describe('exact-match lookup across scopes (spec 7.2)', () => {
  beforeEach(truncateAll);

  it('returns only the six permitted fields', async () => {
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    const result = await lookupRecordByAppsNo(looker, { appsNo: APPS_NO });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = result.data.record;
    expect(record).not.toBeNull();
    if (!record) return;

    // The assertion that matters: the response object carries no other key.
    // Enumeration by lookup is the threat, and the restricted projection is what
    // makes granting the exception safe.
    expect(Object.keys(record).sort()).toEqual([...PERMITTED_KEYS]);

    expect(record.appsNo).toBe(APPS_NO);
    expect(record.clientName).toBe('Ravi Kumar');
    expect(record.smName).toBe('Owner Rep');
    expect(record.status).toBe('ISSUED');
    expect(record.issuedDate).toBe('2026-06-03');
  });

  it('leaks no premium figure, policy number, SM_ID or contact field', async () => {
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    const result = await lookupRecordByAppsNo(looker, { appsNo: APPS_NO });
    if (!result.ok || !result.data.record) throw new Error('expected a match');

    const serialized = JSON.stringify(result.data.record);
    for (const secret of ['0123456789', '4195.42', '50345.00', 'LEAD-99', 'Pune', 'Team Lead', OWNER_SM_ID]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('reports a miss as a miss, and audits it either way', async () => {
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    const hit = await lookupRecordByAppsNo(looker, { appsNo: APPS_NO });
    const miss = await lookupRecordByAppsNo(looker, { appsNo: '9999999999' });

    expect(hit.ok && hit.data.record).toBeTruthy();
    expect(miss.ok && miss.data.record).toBeNull();

    // Section 7.2: every lookup is audited whether or not it matched. A run of
    // misses is what enumeration looks like, so the misses are the rows that
    // matter most.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'RECORD_LOOKUP'));
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => (a.metadata as { matched: boolean }).matched).sort()).toEqual([
      false,
      true,
    ]);
    expect(audits[0].actorId).toBe(looker.id);
  });

  it.each(['61675%', '6167509575 OR 1=1', '*', '', '   ', '6167509575; drop table'])(
    'refuses %j outright — the shape is not an application number',
    async (query) => {
      const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
      await makeRecord();

      const result = await lookupRecordByAppsNo(looker, { appsNo: query });
      expect(result.ok).toBe(false);

      // A refused query never reached the database, so it is not a lookup and
      // does not consume the budget.
      expect(await db.select().from(auditLog)).toHaveLength(0);
    },
  );

  it('treats a truncated application number as a miss, never as a prefix', async () => {
    // The predicate is `eq`, so a shortened number is not "the start of" any
    // record — it is a different number that happens not to exist. It costs a
    // lookup from the hourly budget like any other, which is what makes walking
    // the number space expensive.
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    const result = await lookupRecordByAppsNo(looker, { appsNo: '616750' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.record).toBeNull();
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it('does not find a record by anything other than its application number', async () => {
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    // The client name and the policy number are both indexed and both would
    // match under a search endpoint. This is not one.
    const byPolicy = await lookupRecordByAppsNo(looker, { appsNo: '0123456789' });
    expect(byPolicy.ok && byPolicy.data.record).toBeNull();
  });
});

describe('lookup rate limiting (spec 7.2)', () => {
  beforeEach(truncateAll);

  it('blocks the 21st lookup in an hour', async () => {
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    for (let i = 0; i < LOOKUP_LIMIT_PER_HOUR; i += 1) {
      const result = await lookupRecordByAppsNo(looker, { appsNo: APPS_NO });
      expect(result.ok, `lookup ${i + 1} should be allowed`).toBe(true);
      if (result.ok) expect(result.data.remaining).toBe(LOOKUP_LIMIT_PER_HOUR - i - 1);
    }

    const blocked = await lookupRecordByAppsNo(looker, { appsNo: APPS_NO });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/all 20 record lookups/i);

    // The blocked attempt must NOT be audited as a RECORD_LOOKUP: the limiter
    // counts those rows, so recording rejections would let each one extend the
    // window that caused it and lock the user out permanently.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'RECORD_LOOKUP'));
    expect(audits).toHaveLength(LOOKUP_LIMIT_PER_HOUR);
  });

  it('counts per user, so one rep cannot exhaust another rep budget', async () => {
    const first = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    const second = sessionFor(await makeUser({ role: 'sales', smId: 'C2CM40001' }));
    await makeRecord();

    for (let i = 0; i < LOOKUP_LIMIT_PER_HOUR; i += 1) {
      await lookupRecordByAppsNo(first, { appsNo: APPS_NO });
    }

    expect((await lookupRecordByAppsNo(first, { appsNo: APPS_NO })).ok).toBe(false);
    expect((await lookupRecordByAppsNo(second, { appsNo: APPS_NO })).ok).toBe(true);
  });

  it('counts from the audit log, so a restart does not reset the budget', async () => {
    const looker = sessionFor(await makeUser({ role: 'sales', smId: LOOKER_SM_ID }));
    await makeRecord();

    // Rows written by a previous process are indistinguishable from rows written
    // by this one — which is the entire point of counting them there rather than
    // in memory.
    for (let i = 0; i < LOOKUP_LIMIT_PER_HOUR; i += 1) {
      await db.insert(auditLog).values({
        actorId: looker.id,
        actorEmail: looker.email,
        actorRole: looker.role,
        action: 'RECORD_LOOKUP',
        entityType: 'sales_record',
        entityId: APPS_NO,
      });
    }

    expect((await lookupRecordByAppsNo(looker, { appsNo: APPS_NO })).ok).toBe(false);
  });
});
