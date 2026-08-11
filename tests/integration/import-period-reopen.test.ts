/**
 * Committing into a CLOSED month — the refusal, and the one way past it.
 *
 * The refusal is the safety property and is asserted first: without it, somebody
 * re-uploading a stale export reopens a month everybody signed off on, and the
 * reconciliation is live again with nothing on any screen saying so. See also
 * tests/integration/import-commit.test.ts, which guards the same rule from the
 * end-to-end side.
 *
 * The override exists because the alternative was a dead end at the last button:
 * leave the wizard, reopen on /admin/periods, come back, press Commit again. It
 * is explicit, admin-only, inside the commit transaction, and audited under its
 * own action so the trail can tell it apart from a manual reopen.
 *
 * These batches carry no staged rows on purpose. The period lifecycle is what is
 * under test, and a commit of zero rows exercises it exactly as a commit of
 * fifty thousand does.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { auditLog, manpower, period, uploadBatch } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { commitBatch } from '@/lib/import/commit';
import { makeUser, truncateAll } from '../helpers/db';

let admin: SessionUser;
let verifier: SessionUser;

function sessionUser(row: {
  id: string;
  email: string;
  name: string;
  role: string;
  smId: string | null;
}): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

/**
 * A batch ready for the commit gate, for a named month.
 *
 * The stored file does not exist, deliberately: `readSecondarySheets` treats a
 * missing original as "no secondary sheets" rather than as a reason to refuse a
 * commit whose rows are already staged, so nothing here needs a workbook.
 */
async function validatedBatch(periodCode: string): Promise<string> {
  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: `Dashboard ${periodCode}.xlsb`,
      storedPath: `uploads/${periodCode.replace('-', '/')}/absent.xlsb`,
      fileHash: `hash-${periodCode}-${Math.random()}`,
      periodCode,
      status: 'VALIDATED',
      uploadedBy: admin.id,
    })
    .returning({ id: uploadBatch.id });

  return batch.id;
}

async function periodRow(code: string) {
  const [row] = await db.select().from(period).where(eq(period.code, code));
  return row;
}

async function openCodes(): Promise<string[]> {
  const rows = await db.select().from(period).where(eq(period.status, 'OPEN'));
  return rows.map((row) => row.code).sort();
}

beforeEach(async () => {
  await truncateAll();
  admin = sessionUser(await makeUser({ role: 'admin', smId: null }));
  verifier = sessionUser(await makeUser({ role: 'verifier', smId: null }));

  // `commitBatch` refuses outright while no usable roster exists, and that gate
  // is not what this file is about.
  await db.insert(manpower).values({
    smId: 'REP001',
    smName: 'Ravi Kumar',
    tlId: 'TL001',
    ccmId: 'CCM01',
  });
});

/** July committed, then August — which closes July. */
async function closeJuly() {
  await commitBatch({ batchId: await validatedBatch('2026-07'), actor: admin });
  const august = await commitBatch({ batchId: await validatedBatch('2026-08'), actor: admin });
  expect(august.periodsClosed).toEqual(['Jul 2026']);
}

describe('by default a closed month refuses the commit', () => {
  it('throws PeriodError and leaves the batch and both periods untouched', async () => {
    await closeJuly();

    const backDated = await validatedBatch('2026-07');
    await expect(commitBatch({ batchId: backDated, actor: admin })).rejects.toThrow(
      /Jul 2026 is closed/,
    );

    expect((await periodRow('2026-07')).status).toBe('CLOSED');
    expect(await openCodes()).toEqual(['2026-08']);

    // The whole commit rolled back, so the batch is still awaiting a decision
    // rather than half-applied against a month nobody meant to touch.
    const [batch] = await db.select().from(uploadBatch).where(eq(uploadBatch.id, backDated));
    expect(batch.status).toBe('VALIDATED');
  });

  it('refuses an explicitly falsy flag the same way — nothing but true is an opt-in', async () => {
    await closeJuly();

    await expect(
      commitBatch({
        batchId: await validatedBatch('2026-07'),
        actor: admin,
        reopenClosedPeriod: false,
      }),
    ).rejects.toThrow(/Jul 2026 is closed/);

    expect((await periodRow('2026-07')).status).toBe('CLOSED');
  });
});

describe('the explicit reopen-and-commit override', () => {
  it('commits, leaves the month open, closes the month that was open, and audits it', async () => {
    await closeJuly();
    const august = await periodRow('2026-08');

    const outcome = await commitBatch({
      batchId: await validatedBatch('2026-07'),
      actor: admin,
      reopenClosedPeriod: true,
    });

    expect(outcome.period).toEqual({ code: '2026-07', label: 'Jul 2026' });
    // Named in the outcome, not just done: an admin who is not told which month
    // just closed does not know that reps have lost July's successor.
    expect(outcome.periodsClosed).toEqual(['Aug 2026']);

    // `period_one_open` admits exactly one OPEN row, so this is the assertion
    // that the close and the reopen happened in that order.
    expect(await openCodes()).toEqual(['2026-07']);

    const july = await periodRow('2026-07');
    expect(july.status).toBe('OPEN');
    expect(july.closedBy).toBeNull();
    expect(july.closedAt).toBeNull();
    expect((await periodRow('2026-08')).status).toBe('CLOSED');

    // Its own action, so the trail can answer "which months were reopened by a
    // file rather than by a person".
    const [reopen] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'PERIOD_REOPEN_IMPORT'));

    expect(reopen.entityId).toBe(july.id);
    expect(reopen.actorId).toBe(admin.id);
    expect(reopen.before).toMatchObject({ status: 'CLOSED' });
    expect(reopen.after).toMatchObject({ status: 'OPEN' });
    expect(reopen.metadata).toMatchObject({ code: '2026-07', closedToReopen: ['2026-08'] });

    // The month it closed to get there is recorded as a close, by the same
    // actor, in the same transaction.
    const closes = await db.select().from(auditLog).where(eq(auditLog.action, 'PERIOD_CLOSE'));
    expect(closes.some((row) => row.entityId === august.id)).toBe(true);
  });

  it('is refused for a non-admin, and nothing reopens', async () => {
    await closeJuly();

    const batchId = await validatedBatch('2026-07');
    await expect(
      commitBatch({ batchId, actor: verifier, reopenClosedPeriod: true }),
    ).rejects.toThrow(/Only an administrator can reopen a closed period/);

    expect((await periodRow('2026-07')).status).toBe('CLOSED');
    expect(await openCodes()).toEqual(['2026-08']);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.action, 'PERIOD_REOPEN_IMPORT')),
    ).toEqual([]);

    const [batch] = await db.select().from(uploadBatch).where(eq(uploadBatch.id, batchId));
    expect(batch.status).toBe('VALIDATED');
  });

  it('opens a month that has no period row at all without the flag being needed', async () => {
    // The flag is only ever about a CLOSED row. A month nobody has opened is the
    // ordinary path and must not start asking for an override.
    const outcome = await commitBatch({ batchId: await validatedBatch('2026-09'), actor: admin });
    expect(outcome.period).toEqual({ code: '2026-09', label: 'Sep 2026' });
    expect(await openCodes()).toEqual(['2026-09']);
  });
});
