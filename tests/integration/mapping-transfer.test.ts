import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionEvent,
  correctionRequest,
  manpower,
  notification,
  salesRecord,
  salesRecordVersion,
} from '@/db/schema';
import { applyApproval } from '@/lib/approvals/apply';
import { listCounterpartyRequests } from '@/lib/corrections/queries';
import { submitCorrection } from '@/lib/corrections/service';
import { verifyRequest } from '@/lib/verification/apply';
import { deleteStoredProofs } from '@/lib/storage/files';
import type { SessionUser } from '@/lib/auth/rbac';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

/**
 * The push direction of a mapping correction — 2026-07-29 spec.
 *
 * `tests/integration/corrections-requests.test.ts` covers the pull: a rep
 * claiming a sale out of somebody else's book. This file covers its mirror,
 * where the rep who HOLDS the sale sends it away, and the two properties that
 * only the push has: it starts from a record the rep already owns, so it needs
 * no scoping exception, and it names a destination the submitter does not
 * control, so the destination itself has to be checked.
 *
 * It also covers the counterparty list, which is the part of the feature that
 * is not a correction at all — it is the other rep finding out while the
 * request is still open rather than after it has been applied.
 */

const OWNER = 'ICCSP90766';
const TARGET = 'C2CM21350';
const STRANGER = 'ICCSP11111';

/** A 1×1 PNG. Real bytes, because storeProofUploads sniffs magic numbers. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const proof = (name = 'mandate.png') => ({ name, bytes: new Uint8Array(PNG) });

const sessionFor = (row: { id: string; email: string; name: string; smId: string | null }): SessionUser => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: 'sales',
  smId: row.smId,
  isActive: true,
});

const storedPaths: string[] = [];

async function seed() {
  const ownerRow = await makeUser({ role: 'sales', smId: OWNER, name: 'Priya Sales' });
  const targetRow = await makeUser({ role: 'sales', smId: TARGET, name: 'Ravi Kumar' });
  const verifierRow = await makeUser({ role: 'verifier', smId: null, name: 'Vidya Verifier' });
  const approverRow = await makeUser({ role: 'approver', smId: null, name: 'Anand Approver' });

  // Both reps on the roster: approval resolves sm_name from here, and a
  // transfer to an SM_ID the roster does not know is refused at submission.
  await db.insert(manpower).values([
    { smId: OWNER, smName: 'Priya Sales' },
    { smId: TARGET, smName: 'Ravi Kumar' },
  ]);

  const [record] = await db
    .insert(salesRecord)
    .values({
      appsNo: '6167509575',
      policyNo: 'POL0099887',
      smId: OWNER,
      smName: 'Priya Sales',
      clientName: 'Meera Nair',
      status: 'ISSUED',
    })
    .returning();

  await db.insert(salesRecordVersion).values({
    recordId: record.id,
    version: 1,
    data: record as unknown as Record<string, unknown>,
    changeType: 'IMPORT',
  });

  return {
    owner: sessionFor(ownerRow),
    target: sessionFor(targetRow),
    verifier: { id: verifierRow.id, email: verifierRow.email, role: 'verifier' as const },
    approver: { id: approverRow.id, email: approverRow.email, role: 'approver' as const },
    record,
  };
}

/** The happy-path transfer submission, so the tests below can vary one thing. */
const transfer = (
  actor: SessionUser,
  overrides: Partial<{ appsNo: string; proposedValue: string; description: string }> = {},
) =>
  submitCorrection(actor, {
    category: 'MAPPING',
    direction: 'TRANSFER_OUT',
    appsNo: '6167509575',
    proposedValue: TARGET,
    description: 'Logged under my code by mistake; Ravi worked this one.',
    files: [proof()],
    ...overrides,
  });

const reloadRecord = async (id: string) =>
  (await db.select().from(salesRecord).where(eq(salesRecord.id, id)))[0];

afterEach(async () => {
  await deleteStoredProofs(storedPaths.splice(0));
});

describe('submitting a transfer (2026-07-29 spec 4)', () => {
  beforeEach(truncateAll);

  it('stores the direction, so the row does not have to be read backwards to know which way it moves', async () => {
    const { owner } = await seed();

    const result = await transfer(owner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));

    expect(request.direction).toBe('TRANSFER_OUT');
    expect(request.category).toBe('MAPPING');
    // The field is smId for both directions — which is what lets the open-request
    // index treat a claim and a transfer on one record as the same dispute.
    expect(request.fieldName).toBe('smId');
    expect(request.proposedValue).toBe(TARGET);
    expect(request.originalValue).toBe(OWNER);
    // The SUBMITTER's SM_ID, which for a transfer is the losing side. The
    // column answers "whose request is this", not "who ends up with the sale".
    expect(request.smId).toBe(OWNER);
    expect(request.status).toBe('PENDING');
  });

  it('accepts a policy number, because that is the number a rep actually holds', async () => {
    const { owner, record } = await seed();

    const result = await transfer(owner, { appsNo: 'POL0099887' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));

    // Resolved to the record's real application number, not stored as typed:
    // apps_no is what every downstream consumer joins and displays on.
    expect(request.appsNo).toBe('6167509575');
    expect(request.recordId).toBe(record.id);
  });

  it('refuses a policy number that matches two of the rep own records rather than picking one', async () => {
    const { owner } = await seed();

    // A second record in the same book carrying the same policy number.
    // policy_no is neither unique nor NOT NULL, so this is representable.
    await db.insert(salesRecord).values({
      appsNo: '6167509999',
      policyNo: 'POL0099887',
      smId: OWNER,
      clientName: 'Other Client',
    });

    const result = await transfer(owner, { appsNo: 'POL0099887' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/more than one record/i);
    expect(result.error).toMatch(/application number/i);

    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('refuses to transfer a record the rep does not own, so a push cannot move a stranger sale', async () => {
    const { owner } = await seed();

    await db.insert(salesRecord).values({
      appsNo: '6167500001',
      smId: STRANGER,
      clientName: 'Not Yours',
    });

    const result = await transfer(owner, { appsNo: '6167500001' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The same wording an out-of-scope correction of any other category gets.
    // A rep probing for records must not be able to tell from the message
    // whether the application exists at all.
    expect(result.error).toMatch(/is in your book/i);
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('refuses a transfer to the rep own SM ID, which would burn the record one open slot for nothing', async () => {
    const { owner } = await seed();

    const result = await transfer(owner, { proposedValue: OWNER });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/that one is yours/i);
  });

  it('refuses a destination the Manpower roster does not know, before it reaches a verifier', async () => {
    const { owner } = await seed();

    const result = await transfer(owner, { proposedValue: 'C2CM99999' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not in the Manpower roster/i);
    // The point of checking at submission rather than only warning at approval:
    // a request that cannot be applied cleanly never enters the queue.
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
  });

  it('uppercases the destination, so a lowercase SM ID cannot split a rep book in two', async () => {
    const { owner } = await seed();

    const result = await transfer(owner, { proposedValue: 'c2cm21350' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [request] = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.id, result.data.id));

    expect(request.proposedValue).toBe(TARGET);
  });

  it('tells the receiving rep at submission, not after the record has already moved', async () => {
    const { owner, target } = await seed();

    const result = await transfer(owner);
    expect(result.ok).toBe(true);

    const rows = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, target.id));

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('MAPPING_TRANSFER_PROPOSED');
    expect(rows[0].title).toContain('6167509575');

    // And nothing was sent to the submitter — they are looking at the request
    // they just raised.
    const ownerRows = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, owner.id));
    expect(ownerRows).toHaveLength(0);
  });

  it('still succeeds when the receiving rep has no portal account', async () => {
    const { owner } = await seed();

    // On the roster — so the name resolves — but with nobody able to sign in as
    // them. Seven such SM_IDs exist in the June data.
    await db.insert(manpower).values({ smId: 'ICCSP55555', smName: 'No Account' });

    const result = await transfer(owner, { proposedValue: 'ICCSP55555' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await db.select().from(correctionRequest)).toHaveLength(1);
  });
});

describe('one open ownership dispute per record (2026-07-29 spec 2)', () => {
  beforeEach(truncateAll);

  it('refuses a claim on a record that already has an open transfer', async () => {
    const { owner, record } = await seed();

    const first = await transfer(owner);
    expect(first.ok).toBe(true);

    // The target rep now tries to claim the same sale. Both target smId, so
    // `correction_one_open_per_field` is what stops them — the two directions
    // never had to know about each other.
    const claimant = await makeUser({ role: 'sales', smId: TARGET, name: 'Second Account' });

    const second = await submitCorrection(sessionFor(claimant), {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: '6167509575',
      proposedValue: TARGET,
      files: [proof()],
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/already has an open correction/i);

    const rows = await db
      .select()
      .from(correctionRequest)
      .where(eq(correctionRequest.recordId, record.id));
    expect(rows).toHaveLength(1);
  });
});

describe('the direction CHECK (2026-07-29 spec 3.2)', () => {
  beforeEach(truncateAll);

  it('rejects a MAPPING row with no direction', async () => {
    const { owner, record } = await seed();

    const message = await expectDbError(
      db.insert(correctionRequest).values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'MAPPING',
        fieldName: 'smId',
        fieldLabel: 'SM ID',
        proposedValue: TARGET,
        submittedBy: owner.id,
        smId: OWNER,
      }),
      /correction_direction_iff_mapping/,
    );

    expect(message).toMatch(/correction_direction_iff_mapping/);
  });

  it('rejects a direction on a category that has no use for one', async () => {
    const { owner, record } = await seed();

    await expectDbError(
      db.insert(correctionRequest).values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'AUTOPAY',
        direction: 'CLAIM_IN',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        proposedValue: 'Yes',
        submittedBy: owner.id,
        smId: OWNER,
      }),
      /correction_direction_iff_mapping/,
    );
  });
});

describe('the counterparty list (2026-07-29 spec 5)', () => {
  beforeEach(truncateAll);

  it('shows an open transfer to the rep it would move the sale to', async () => {
    const { owner, target } = await seed();

    await transfer(owner);

    const rows = await listCounterpartyRequests(target);

    expect(rows).toHaveLength(1);
    expect(rows[0].appsNo).toBe('6167509575');
    expect(rows[0].policyNo).toBe('POL0099887');
    expect(rows[0].clientName).toBe('Meera Nair');
    expect(rows[0].direction).toBe('TRANSFER_OUT');
    expect(rows[0].currentSmId).toBe(OWNER);
    expect(rows[0].proposedSmId).toBe(TARGET);
    // Derived from where the sale sits, not from who asked: the receiving rep
    // is gaining it whichever of them raised the request.
    expect(rows[0].role).toBe('GAINING');
  });

  it('does not show a rep their own request, which they already see under my requests', async () => {
    const { owner } = await seed();

    await transfer(owner);

    expect(await listCounterpartyRequests(owner)).toHaveLength(0);
  });

  it('shows nothing to a rep who is neither side of it', async () => {
    const { owner } = await seed();
    const bystander = await makeUser({ role: 'sales', smId: STRANGER, name: 'Uninvolved' });

    await transfer(owner);

    expect(await listCounterpartyRequests(sessionFor(bystander))).toHaveLength(0);
  });

  it('keeps showing it while it is VERIFIED, and drops it once it is applied', async () => {
    const { owner, target, verifier, approver } = await seed();

    const result = await transfer(owner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await verifyRequest({ requestId: result.data.id, actor: verifier });
    // Still open — it is with the approver, and the sale has not moved yet.
    expect(await listCounterpartyRequests(target)).toHaveLength(1);

    await applyApproval({ requestId: result.data.id, actor: approver });
    // Decided. The record is theirs now, so it belongs in their record list
    // rather than in a list of things that might happen.
    expect(await listCounterpartyRequests(target)).toHaveLength(0);
  });

  it('shows a claim to the rep who would lose the sale, not only transfers', async () => {
    const { owner, record } = await seed();
    const claimant = await makeUser({ role: 'sales', smId: TARGET, name: 'Ravi Claiming' });

    await submitCorrection(sessionFor(claimant), {
      category: 'MAPPING',
      direction: 'CLAIM_IN',
      appsNo: record.appsNo,
      proposedValue: TARGET,
      files: [proof()],
    });

    const rows = await listCounterpartyRequests(owner);

    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('CLAIM_IN');
    expect(rows[0].role).toBe('LOSING');
  });
});

describe('the full path, transfer to applied (2026-07-29 spec 8)', () => {
  beforeEach(truncateAll);

  it('moves sm_id and sm_name together and tells both reps', async () => {
    const { owner, target, verifier, approver, record } = await seed();

    const submitted = await transfer(owner);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    await verifyRequest({ requestId: submitted.data.id, actor: verifier });
    const outcome = await applyApproval({ requestId: submitted.data.id, actor: approver });

    // The record moved, name and all. sm_name came from the roster, never from
    // anything the submitter typed.
    const moved = await reloadRecord(record.id);
    expect(moved.smId).toBe(TARGET);
    expect(moved.smName).toBe('Ravi Kumar');
    expect(moved.hasCorrections).toBe(true);
    expect(outcome.warnings).toEqual([]);

    // One new version, naming both columns — the under-reporting that an
    // OTHERS-on-smId request produced is exactly what this asserts against.
    const versions = await db
      .select()
      .from(salesRecordVersion)
      .where(eq(salesRecordVersion.recordId, record.id));
    expect(versions).toHaveLength(2);
    const applied = versions.find((v) => v.version === 2);
    expect(applied?.changedFields?.sort()).toEqual(['smId', 'smName']);

    const events = await db
      .select()
      .from(correctionEvent)
      .where(eq(correctionEvent.requestId, submitted.data.id));
    expect(events.map((e) => e.action).sort()).toEqual(['APPROVED', 'SUBMITTED', 'VERIFIED']);

    // The submitter is the LOSING rep here, which is the inversion of a claim.
    // They get the reassignment notice rather than a generic approval one,
    // because the mapping wording is the more informative of the two.
    const ownerNotes = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, owner.id));
    expect(ownerNotes.map((n) => n.type)).toContain('MAPPING_LOST');
    expect(ownerNotes.map((n) => n.type)).not.toContain('CORRECTION_APPROVED');

    const targetNotes = await db
      .select()
      .from(notification)
      .where(eq(notification.userId, target.id));
    expect(targetNotes.map((n) => n.type).sort()).toEqual([
      'MAPPING_GAINED',
      'MAPPING_TRANSFER_PROPOSED',
    ]);
  });

  it('describes an approved transfer as a transfer, not as somebody claim', async () => {
    const { owner, verifier, approver } = await seed();

    const submitted = await transfer(owner);
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) return;

    await verifyRequest({ requestId: submitted.data.id, actor: verifier });
    await applyApproval({ requestId: submitted.data.id, actor: approver });

    // By type, not by position. The submitter also collects CORRECTION_VERIFIED
    // on the way through, so the first row in this table is the verifier's.
    const [lost] = await db
      .select()
      .from(notification)
      .where(
        and(eq(notification.userId, owner.id), eq(notification.type, 'MAPPING_LOST')),
      );

    // The old wording told the rep who ASKED to give the sale away that
    // somebody had taken it from them.
    expect(lost.body).toMatch(/your transfer request was approved/i);
    expect(lost.body).not.toMatch(/mapping claim/i);
  });
});
