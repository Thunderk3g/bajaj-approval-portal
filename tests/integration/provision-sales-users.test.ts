import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { account, auditLog, lead, user } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { createUserAccount } from '@/lib/auth/provision';
import {
  emailForSmCode,
  generatePassword,
  listLeadOwners,
  provisionSalesUsers,
  refusalFor,
} from '../../scripts/provision-sales-users';
import { truncateAll } from '../helpers/db';

/**
 * `npm run setup:sales` mints accounts whose passwords exist nowhere but on the
 * operator's screen, so the two failures worth guarding are both silent ones:
 * a rerun that rotates a password somebody is already using, and a second login
 * onto a book that already has one.
 *
 * These exercise `provisionSalesUsers` directly rather than the CLI. The printing
 * is not the contract; what lands in `user` and `account` is.
 */

const SENTINEL = '111222-UN';

let leadCounter = 0;

async function makeLeads(
  smCode: string | null,
  count: number,
  options: { smName?: string; unassigned?: boolean } = {},
): Promise<void> {
  await db.insert(lead).values(
    Array.from({ length: count }, () => ({
      leadNo: `L${(leadCounter += 1)}-${randomUUID()}`,
      smCode,
      smName: options.smName ?? null,
      isUnassigned: options.unassigned ?? false,
    })),
  );
}

function run(limit: number | null = null) {
  return provisionSalesUsers({ limit, dryRun: false });
}

describe('provision-sales-users', () => {
  beforeEach(truncateAll);

  it('gives every lead-owning code an account at the address derived from the code', async () => {
    await makeLeads('ICCS427343', 3, { smName: 'kiran.rokade' });
    await makeLeads('C2CM24850', 1);

    const report = await run();

    expect(report.created.map((a) => a.smCode).sort()).toEqual(['C2CM24850', 'ICCS427343']);

    const row = await db.query.user.findFirst({
      where: eq(user.email, emailForSmCode('ICCS427343')),
    });
    expect(row?.role).toBe('sales');
    expect(row?.smId).toBe('ICCS427343');
    expect(row?.isActive).toBe(true);
    // The name comes off the sheet; the code is the fallback when it is blank,
    // because `user.name` is NOT NULL and an empty label is unusable in a queue.
    expect(row?.name).toBe('kiran.rokade');
    const unnamed = await db.query.user.findFirst({
      where: eq(user.email, emailForSmCode('C2CM24850')),
    });
    expect(unnamed?.name).toBe('C2CM24850');
  });

  it('stores the password it printed, hashed the way sign-in checks it', async () => {
    await makeLeads('ICCS427343', 1);

    const report = await run();
    const created = report.created[0];

    const [row] = await db
      .select({ password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.email, created.email));

    // Verified through Better Auth's own hasher rather than by comparing
    // strings: a hash this script wrote by hand would satisfy any assertion
    // about the column and still fail every real sign-in.
    const ctx = await auth.$context;
    expect(await ctx.password.verify({ hash: row.password!, password: created.password })).toBe(true);
    expect(await ctx.password.verify({ hash: row.password!, password: `${created.password}x` })).toBe(
      false,
    );
  });

  it('leaves an existing account alone, including its password', async () => {
    await makeLeads('ICCS427343', 2);
    const first = await run();
    const original = first.created[0].password;

    const [before] = await db
      .select({ password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.smId, 'ICCS427343'));

    const second = await run();

    expect(second.created).toHaveLength(0);
    expect(second.skippedExisting).toEqual([
      { smCode: 'ICCS427343', email: emailForSmCode('ICCS427343') },
    ]);

    const [after] = await db
      .select({ password: account.password })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(eq(user.smId, 'ICCS427343'));

    // Byte-identical, not merely "still verifies": a rehash of the same password
    // would also verify, and would still mean the rerun rewrote a credential it
    // had no business touching.
    expect(after.password).toBe(before.password);

    const ctx = await auth.$context;
    expect(await ctx.password.verify({ hash: after.password!, password: original })).toBe(true);

    const rows = await db.select().from(user).where(eq(user.smId, 'ICCS427343'));
    expect(rows).toHaveLength(1);
  });

  it('recognises a code already provisioned under a hand-made address', async () => {
    // The live deployment's sm1@ holds ICCSP90766 and sm2@ holds C2CM21350, and
    // both own leads. Matching on the derived email alone would find no
    // sm.iccsp90766@ and hand one rep a second login onto the same book.
    await createUserAccount({
      name: 'Demo Rep',
      email: 'sm1@bajajlife.com',
      password: 'correct-horse-battery',
      role: 'sales',
      smId: 'ICCSP90766',
    });
    await makeLeads('ICCSP90766', 4);

    const report = await run();

    expect(report.created).toHaveLength(0);
    expect(report.skippedExisting).toEqual([
      { smCode: 'ICCSP90766', email: 'sm1@bajajlife.com' },
    ]);
    expect(await db.select().from(user).where(eq(user.smId, 'ICCSP90766'))).toHaveLength(1);
  });

  it('never provisions the unassigned pool, and counts it instead', async () => {
    await makeLeads(SENTINEL, 5, { unassigned: true });
    await makeLeads('ICCS427343', 1);

    const report = await run();

    expect(report.created.map((a) => a.smCode)).toEqual(['ICCS427343']);
    expect(report.unassignedLeads).toBe(5);
    expect(await db.select().from(user).where(eq(user.smId, SENTINEL))).toHaveLength(0);
  });

  it('refuses the sentinel by name when the denormalised flag disagrees with it', async () => {
    // `is_unassigned` false on a `111222-UN` row means the flag and the column it
    // was derived from have drifted. The row must not become a login, and the
    // drift must be visible rather than filtered away in SQL.
    await makeLeads(SENTINEL, 2, { unassigned: false });

    const report = await run();

    expect(report.created).toHaveLength(0);
    expect(report.refused).toEqual([{ smCode: SENTINEL, reason: refusalFor(SENTINEL) }]);
    expect(report.unassignedLeads).toBe(2);
  });

  it('refuses a code /admin/users would not let an admin edit afterwards', async () => {
    await makeLeads('AB-CD-99', 3);

    const report = await run();

    expect(report.created).toHaveLength(0);
    expect(report.refused[0].smCode).toBe('AB-CD-99');
    expect(report.refused[0].reason).toMatch(/A-Z0-9/);
  });

  it('caps at --limit, takes the busiest reps, and says how many it left', async () => {
    await makeLeads('AAA111', 5);
    await makeLeads('BBB222', 3);
    await makeLeads('CCC333', 1);

    const report = await run(2);

    expect(report.created.map((a) => a.smCode)).toEqual(['AAA111', 'BBB222']);
    expect(report.droppedByLimit).toBe(1);
    expect(report.candidates).toBe(3);
  });

  it('counts provisioned codes the Manpower roster has never heard of', async () => {
    await makeLeads('ICCS427343', 2);

    const report = await run();

    // The roster is empty, so both the count and the flag say the same thing:
    // these reps are real and the roster sheet is behind. Provisioned anyway.
    expect(report.offRoster).toBe(1);
    expect((await listLeadOwners())[0].onRoster).toBe(false);
  });

  it('writes a USER_CREATE row naming the run, and never the password', async () => {
    await makeLeads('ICCS427343', 2);

    const report = await run();

    const rows = await db.select().from(auditLog).where(eq(auditLog.action, 'USER_CREATE'));
    expect(rows).toHaveLength(1);
    // No session behind a CLI run, so no actor. The row is still the only
    // durable evidence the account was machine-provisioned.
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].entityType).toBe('user');
    expect(rows[0].metadata).toMatchObject({
      via: 'provision-sales-users',
      roster: 'absent',
      needsRosterReview: true,
      leads: 2,
    });
    expect(JSON.stringify(rows[0])).not.toContain(report.created[0].password);
  });

  it('does nothing at all when the lead table is empty', async () => {
    // The normal running order is reset, upload, import Lead Dump, provision.
    // Somebody will run this at step one, and it has to say so rather than
    // crash on an empty result or report a successful run of zero.
    const report = await run();

    expect(report.candidates).toBe(0);
    expect(report.created).toHaveLength(0);
    expect(report.refused).toHaveLength(0);
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it('distinguishes an empty roster from a stale one', async () => {
    // With `manpower` empty, "no roster row" is one missing sheet, not two
    // hundred missing people. The count is what lets the CLI say which.
    await makeLeads('ICCS427343', 1);

    expect((await run()).rosterRows).toBe(0);
  });

  it('creates nothing on a dry run', async () => {
    await makeLeads('ICCS427343', 2);

    const report = await provisionSalesUsers({ limit: null, dryRun: true });

    expect(report.created).toHaveLength(1);
    expect(report.created[0].password).toBe('(dry run)');
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it('derives a stable address and a password nobody has to squint at', async () => {
    expect(emailForSmCode('ICCS427343')).toBe('sm.iccs427343@bajajlife.com');
    expect(emailForSmCode('ICCS427343')).toBe(emailForSmCode('ICCS427343'));

    const password = generatePassword();
    // Better Auth's minPasswordLength is 12; these are typed off a printed page,
    // so the ambiguous glyphs are excluded on purpose.
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(password).not.toMatch(/[lI1O0]/);
    expect(generatePassword()).not.toBe(password);
  });
});
