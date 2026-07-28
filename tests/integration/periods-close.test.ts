import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionAttachment, correctionRequest, period, salesRecord } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import {
  PeriodError,
  closePeriod,
  getOrCreatePeriod,
  periodBounds,
  periodCodeFor,
  periodLabelFor,
  reopenPeriod,
} from '@/lib/periods/service';
import { resubmitCorrection, submitCorrection } from '@/lib/corrections/service';
import { returnFromVerification, verifyRequest } from '@/lib/verification/apply';
import { applyApproval } from '@/lib/approvals/apply';
import { deleteStoredProofs } from '@/lib/storage/files';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

/**
 * The monthly close — 2026-07-28 spec section 4.4.
 *
 * The rule under test is narrow and easy to get wrong in either direction:
 * a closed period blocks NEW claims and NOTHING else. Blocking more would
 * strand the requests that were mid-review when the month turned, which is the
 * moment the queue is fullest; blocking less would make the close meaningless.
 */

const OWNER = 'ICCSP90766';

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const proof = (name = 'proof.png') => ({ name, bytes: PNG });

function sessionFor(row: {
  id: string;
  name: string;
  email: string;
  role: string;
  smId: string | null;
}): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as SessionUser['role'],
    smId: row.smId,
    isActive: true,
  };
}

async function seed() {
  const adminRow = await makeUser({ role: 'admin', smId: null });
  const repRow = await makeUser({ role: 'sales', smId: OWNER });
  const verifierRow = await makeUser({ role: 'verifier', smId: null });
  const approverRow = await makeUser({ role: 'approver', smId: null });

  const admin = sessionFor(adminRow);
  const rep = sessionFor(repRow);
  const verifier = { id: verifierRow.id, email: verifierRow.email, role: 'verifier' as const };
  const approver = { id: approverRow.id, email: approverRow.email, role: 'approver' as const };

  const june = await getOrCreatePeriod('2026-06', admin.id);

  const [record] = await db
    .insert(salesRecord)
    .values({
      appsNo: '6167509575',
      smId: OWNER,
      clientName: 'Meera Nair',
      status: 'ISSUED',
      autopay: null,
      periodId: june.id,
    })
    .returning();

  return { admin, rep, verifier, approver, june, record };
}

/** Removes the proof files these tests write, so the storage dir does not grow. */
async function clearStoredProofs() {
  const rows = await db.select({ path: correctionAttachment.storedPath }).from(correctionAttachment);
  await deleteStoredProofs(rows.map((r) => r.path));
}

describe('period arithmetic', () => {
  it('derives the code from UTC, not from the server timezone', () => {
    // A boundary that moves with the deployment host is a boundary nobody can
    // reconcile against: on IST, 05:00 UTC on the 1st is already the new month
    // locally while a UTC read says otherwise.
    expect(periodCodeFor(new Date('2026-07-01T00:00:00.000Z'))).toBe('2026-07');
    expect(periodCodeFor(new Date('2026-07-31T23:59:59.999Z'))).toBe('2026-07');
    expect(periodCodeFor(new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12');
  });

  it('labels and bounds the month, leap years included', () => {
    expect(periodLabelFor('2026-07')).toBe('Jul 2026');
    expect(periodBounds('2026-07')).toEqual({ startsOn: '2026-07-01', endsOn: '2026-07-31' });
    expect(periodBounds('2026-02')).toEqual({ startsOn: '2026-02-01', endsOn: '2026-02-28' });
    expect(periodBounds('2024-02')).toEqual({ startsOn: '2024-02-01', endsOn: '2024-02-29' });
  });

  it('refuses anything that is not YYYY-MM', () => {
    expect(() => periodLabelFor('Jul-2026')).toThrow(PeriodError);
    expect(() => periodBounds('2026-13')).toThrow(PeriodError);
  });
});

describe('only one period is open at a time', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  it('rejects a second open period at the database', async () => {
    const admin = sessionFor(await makeUser({ role: 'admin', smId: null }));
    await getOrCreatePeriod('2026-06', admin.id);

    // The partial unique index is the guarantee, not the application code:
    // "which period are we in?" must have one answer no matter which path asks.
    await expectDbError(
      db.insert(period).values({
        code: '2026-07',
        label: 'Jul 2026',
        startsOn: '2026-07-01',
        endsOn: '2026-07-31',
        status: 'OPEN',
      }),
      /period_one_open/,
    );
  });

  it('refuses to reopen a period while another is open', async () => {
    const admin = sessionFor(await makeUser({ role: 'admin', smId: null }));
    const june = await getOrCreatePeriod('2026-06', admin.id);
    await closePeriod(june.id, admin);
    const july = await getOrCreatePeriod('2026-07', admin.id);

    await expect(reopenPeriod(june.id, admin)).rejects.toThrow(/Jul 2026 is currently open/);
    expect((await db.select().from(period).where(eq(period.id, july.id)))[0].status).toBe('OPEN');
  });
});

describe('closing a period', () => {
  beforeEach(truncateAll);
  afterEach(clearStoredProofs);

  it('blocks a NEW correction against a record in that period', async () => {
    const { admin, rep, june, record } = await seed();

    await closePeriod(june.id, admin);

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Jun 2026 is closed/);
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('is enforced by the database even if the check is bypassed', async () => {
    const { admin, rep, june, record } = await seed();
    await closePeriod(june.id, admin);

    // The application check produces the message a rep can act on; this trigger
    // is what closes the race where the period is closed between that check and
    // the insert — which is precisely when the monthly upload is running.
    await expectDbError(
      db.insert(correctionRequest).values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: rep.id,
        smId: OWNER,
        periodId: june.id,
      }),
      /correction_period_must_be_open|Jun 2026 is closed/,
    );
  });

  it('lets everything already in flight finish', async () => {
    const { admin, rep, verifier, approver, june, record } = await seed();

    const submitted = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    // The month turns while the request is mid-review. Everything downstream
    // must keep working: a close that stranded these would hit hardest exactly
    // when the queue is fullest.
    const outcome = await closePeriod(june.id, admin);
    expect(outcome.openRequests).toBe(1);

    await returnFromVerification({
      requestId: submitted.data.id,
      actor: verifier,
      remarks: 'Attach the mandate PDF.',
    });

    const resubmitted = await resubmitCorrection(rep, {
      requestId: submitted.data.id,
      proposedValue: 'Yes',
      files: [proof('mandate.png')],
    });
    expect(resubmitted.ok).toBe(true);

    await verifyRequest({ requestId: submitted.data.id, actor: verifier });
    await applyApproval({ requestId: submitted.data.id, actor: approver });

    const [final] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, submitted.data.id));
    expect(final.status).toBe('APPROVED');

    const [after] = await db.select().from(salesRecord).where(eq(salesRecord.id, record.id));
    expect(after.autopay).toBe('Yes');
  });

  it('reports what was in flight but never refuses because of it', async () => {
    const { admin, rep, verifier, june, record } = await seed();

    const first = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    if (!first.ok) throw new Error('seed failed');
    await verifyRequest({ requestId: first.data.id, actor: verifier });

    const second = await submitCorrection(rep, {
      category: 'ISSUANCE_DATE',
      appsNo: record.appsNo,
      proposedValue: '2026-06-03',
      files: [proof()],
    });
    expect(second.ok).toBe(true);

    // A close that any one unreviewed request could veto is a close that will
    // not happen, and the monthly upload would stall behind it.
    const outcome = await closePeriod(june.id, admin);
    expect(outcome.openRequests).toBe(2);
    expect(outcome.period.status).toBe('CLOSED');
    expect(outcome.period.closedBy).toBe(admin.id);
  });

  it('does not touch records that belong to no period', async () => {
    const { admin, rep, june } = await seed();
    await closePeriod(june.id, admin);

    // Null means "imported before the portal tracked periods", not "in some
    // period that might be closed". Freezing those would make every pre-existing
    // record permanently uncorrectable.
    const [legacy] = await db
      .insert(salesRecord)
      .values({ appsNo: '5920000009', smId: OWNER, status: 'ISSUED', periodId: null })
      .returning();

    const result = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: legacy.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });

    expect(result.ok).toBe(true);
  });

  it('refuses to close a period twice', async () => {
    const { admin, june } = await seed();
    await closePeriod(june.id, admin);
    await expect(closePeriod(june.id, admin)).rejects.toThrow(/already closed/);
  });

  it('reopening restores the ability to raise new claims', async () => {
    const { admin, rep, june, record } = await seed();

    await closePeriod(june.id, admin);
    const blocked = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    expect(blocked.ok).toBe(false);

    // Closing is otherwise irreversible from the rep's side, and a month closed
    // a day early would leave real corrections unraisable with no remedy short
    // of a database edit — the uncontrolled change this portal exists to replace.
    await reopenPeriod(june.id, admin);

    const allowed = await submitCorrection(rep, {
      category: 'AUTOPAY',
      appsNo: record.appsNo,
      proposedValue: 'Yes',
      files: [proof()],
    });
    expect(allowed.ok).toBe(true);

    if (allowed.ok) {
      const [row] = await db
        .select()
        .from(correctionRequest)
        .where(eq(correctionRequest.id, allowed.data.id));
      // Stamped with the record's period, not the "current" one — a record still
      // sitting in June's cycle is June's work.
      expect(row.periodId).toBe(june.id);
    }
  });
});

