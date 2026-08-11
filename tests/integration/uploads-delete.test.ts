import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditLog,
  correctionRequest,
  ingestJob,
  lead,
  manpower,
  manpowerOverride,
  salesRecord,
  uploadBatch,
  uploadBatchRow,
} from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import type { Role, SessionUser } from '@/lib/auth/rbac';
import { allocateStoragePath, ensureStorageDirs, UPLOADS_DIR } from '@/lib/storage/paths';
import { expectDbError, makeUser, truncateAll } from '../helpers/db';

/**
 * `deleteBatchAction` — the one control in the import pipeline that destroys
 * something.
 *
 * Everything an upload owns is spread across four places that fail
 * independently: two cascading tables, one table that does NOT cascade, and a
 * file on disk that the database knows nothing about. A delete that gets three
 * of the four right looks exactly like one that got all four right until an
 * admin goes looking for the leads that came back, or for the nine megabytes
 * that never left. So every test below asserts all four, even where only one is
 * the point.
 *
 * The refusals get the same treatment for the opposite reason: a guard that
 * fires but has already removed something is worse than no guard, because the
 * admin is told nothing happened.
 */

const session = vi.hoisted(() => ({ user: null as SessionUser | null }));

/**
 * The proxy chain and the browser string a real request would carry.
 *
 * Hoisted rather than declared below because the `next/headers` factory runs
 * during the static imports above it, when a plain `const` here would still be
 * in its temporal dead zone.
 */
const REQUEST = vi.hoisted(() => ({
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0 (admin console)',
}));

/**
 * Only the session SOURCE is faked. `requireRole` — the admin-only rule these
 * tests are here to pin down — is the real one, reached through the real
 * `requireSession` and the real `getSession`. Stubbing `requireRole` itself
 * would move that rule into the mock, and the suite would then keep passing
 * over an action that had quietly been widened to approvers.
 */
vi.mock('@/lib/auth/server', () => ({
  auth: {
    api: {
      getSession: async () => (session.user ? { user: session.user } : null),
    },
  },
}));

// Both of these throw outside a request scope, so the action cannot be called
// at all without them. The header values are real ones rather than blanks: they
// are copied onto the audit row, and that row is the only thing left after this
// action runs.
vi.mock('next/headers', () => ({
  headers: async () =>
    new Headers({
      // Two hops, because the action takes the first entry and trims it. A
      // deployment behind shared-nginx never sends just one.
      'x-forwarded-for': `${REQUEST.ip}, 10.3.5.99`,
      'user-agent': REQUEST.userAgent,
    }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));

const { deleteBatchAction } = await import('@/lib/import/actions');

const FILE_NAME = "Businesses Dashboard Jun'26.xlsb";
const SM_CODE = 'ICCS427343';

function sessionFor(row: {
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
    role: row.role as Role,
    smId: row.smId,
    isActive: true,
  };
}

/** Absolute paths written by {@link seedBatch}, so a refused delete leaves none behind. */
const createdFiles: string[] = [];

type Seeded = {
  batchId: string;
  storedPath: string;
  absolutePath: string;
  fileHash: string;
};

/**
 * A batch as the admin would have left it at the moment they decided to delete
 * it: the workbook on disk, rows staged from it, leads imported from it, and
 * the finished jobs that produced both.
 *
 * The two jobs are SUCCEEDED and FAILED deliberately. Only QUEUED and RUNNING
 * hold a worker, and an over-broad in-flight check would make every batch that
 * ever parsed permanently undeletable — a bug the happy path below would not
 * otherwise notice, because it would present as a refusal rather than as loss.
 */
async function seedBatch(
  adminId: string,
  options: { status?: 'VALIDATED' | 'COMMITTED'; leadNoPrefix?: string } = {},
): Promise<Seeded> {
  const status = options.status ?? 'VALIDATED';
  // The action never reads the file, only unlinks it, so the bytes need only be
  // distinct enough to give each batch its own hash.
  const bytes = Buffer.from(`workbook ${randomUUID()}`);
  const fileHash = createHash('sha256').update(bytes).digest('hex');

  await ensureStorageDirs();
  const { absolutePath, relativePath } = await allocateStoragePath(UPLOADS_DIR, 'xlsb');
  await writeFile(absolutePath, bytes);
  createdFiles.push(absolutePath);

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: FILE_NAME,
      storedPath: relativePath,
      fileHash,
      sheetName: 'Login Data',
      status,
      totalRows: 2,
      validRows: 2,
      uploadedBy: adminId,
      committedBy: status === 'COMMITTED' ? adminId : null,
      committedAt: status === 'COMMITTED' ? new Date() : null,
    })
    .returning({ id: uploadBatch.id });

  await db.insert(uploadBatchRow).values([
    { batchId: batch.id, rowNumber: 2, raw: { Apps_No: '5920000001' }, status: 'COMMITTED' },
    { batchId: batch.id, rowNumber: 3, raw: { Apps_No: '5920000002' }, status: 'VALID' },
  ]);

  await db.insert(ingestJob).values([
    { kind: 'PARSE', status: 'SUCCEEDED', batchId: batch.id, requestedBy: adminId },
    { kind: 'LEADS', status: 'FAILED', batchId: batch.id, error: 'the sheet was not found' },
  ]);

  const prefix = options.leadNoPrefix ?? 'LEAD';
  await db.insert(lead).values([
    { leadNo: `${prefix}-1`, smCode: SM_CODE, smName: 'Aarti Rep', sourceBatchId: batch.id },
    { leadNo: `${prefix}-2`, smCode: SM_CODE, smName: 'Aarti Rep', sourceBatchId: batch.id },
  ]);

  return { batchId: batch.id, storedPath: relativePath, absolutePath, fileHash };
}

/**
 * Everything still pointing at the batch, counted in one shot.
 *
 * Returned as an object so an assertion names all four at once. Four separate
 * `toHaveLength` calls would stop at the first, and the first is the batch row —
 * the one that is right in every failure mode worth catching.
 */
async function survivors(batchId: string) {
  const [batches, rows, jobs, leads] = await Promise.all([
    db.select({ id: uploadBatch.id }).from(uploadBatch).where(eq(uploadBatch.id, batchId)),
    db.select({ id: uploadBatchRow.id }).from(uploadBatchRow).where(eq(uploadBatchRow.batchId, batchId)),
    db.select({ id: ingestJob.id }).from(ingestJob).where(eq(ingestJob.batchId, batchId)),
    db.select({ id: lead.id }).from(lead).where(eq(lead.sourceBatchId, batchId)),
  ]);
  return { batch: batches.length, stagedRows: rows.length, jobs: jobs.length, leads: leads.length };
}

/** What {@link seedBatch} leaves behind, i.e. the state a refusal must preserve. */
const INTACT = { batch: 1, stagedRows: 2, jobs: 2, leads: 2 };
const GONE = { batch: 0, stagedRows: 0, jobs: 0, leads: 0 };

let admin: SessionUser;

beforeEach(async () => {
  await truncateAll();
  admin = sessionFor(await makeUser({ role: 'admin', name: 'Import Admin', smId: null }));
  session.user = admin;
});

afterEach(async () => {
  await Promise.all(createdFiles.map((path) => unlink(path).catch(() => undefined)));
  createdFiles.length = 0;
});

describe('deleting an upload removes all of it', () => {
  it('takes the batch, its staged rows, its jobs, its leads and the stored file', async () => {
    const seeded = await seedBatch(admin.id);

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // recordsRemoved is 0 on a batch that never committed — there are no master
    // records to take with it.
    expect(result.data).toEqual({ leadsRemoved: 2, fileRemoved: true, recordsRemoved: 0 });

    // Three different mechanisms: upload_batch_row and ingest_job go by
    // ON DELETE CASCADE, the leads had to be deleted explicitly, and the file is
    // not in the database at all. Any one of them can regress alone.
    expect(await survivors(seeded.batchId)).toEqual(GONE);
    expect(existsSync(seeded.absolutePath)).toBe(false);
  });

  it('deletes a draft whose roster step has already run, and takes that roster with it', async () => {
    /**
     * The regression this file exists to prevent, and it reached production.
     *
     * The roster step runs BEFORE the policy commit — it is step 1 on the review
     * screen — so a batch that is still VALIDATED can already own `manpower`
     * rows. The cleanup used to sit inside the COMMITTED branch, leaving
     * `manpower.source_batch_id` pointing at a batch the delete was trying to
     * remove: Postgres refused with
     * `manpower_source_batch_id_upload_batch_id_fk`, and the admin was told
     * "other data still refers to it" about a step the same page had just walked
     * them through. Every such upload was undeletable.
     */
    const seeded = await seedBatch(admin.id, { status: 'VALIDATED' });
    await db.insert(manpower).values([
      { smId: SM_CODE, smName: 'Aarti Rep', tlId: 'TL001', ccmId: 'CCM001', sourceBatchId: seeded.batchId },
      { smId: 'ICCS999999', smName: 'Other Rep', tlId: 'TL001', ccmId: 'CCM001', sourceBatchId: seeded.batchId },
      // Written by an earlier import: it has no reference to this batch and must
      // survive, or deleting one upload would empty the whole roster.
      { smId: 'ICCS111111', smName: 'Earlier Rep', tlId: 'TL002', ccmId: 'CCM001' },
    ]);

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(true);
    expect(await survivors(seeded.batchId)).toEqual(GONE);
    expect((await db.select({ smId: manpower.smId }).from(manpower)).map((r) => r.smId)).toEqual([
      'ICCS111111',
    ]);
  });

  it('leaves the audit entry standing as the only evidence the file ever existed', async () => {
    const seeded = await seedBatch(admin.id);

    await deleteBatchAction({ batchId: seeded.batchId });

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'UPLOAD_DELETE'));

    // `audit_log.entity_id` carries no foreign key, so it still names a batch row
    // that no longer exists — which is the entire point of auditing a deletion.
    expect(entry.entityId).toBe(seeded.batchId);
    expect(await survivors(seeded.batchId)).toEqual(GONE);

    expect(entry.entityType).toBe('upload_batch');
    expect(entry.actorEmail).toBe(admin.email);
    expect(entry.actorRole).toBe('admin');

    // The name identifies the file to a human, the hash identifies it to a
    // re-upload, and the path is the only thing that makes an orphaned copy on
    // disk findable. None of the three can be recovered from anywhere else.
    expect(entry.before).toMatchObject({
      originalFileName: FILE_NAME,
      fileHash: seeded.fileHash,
      storedPath: seeded.storedPath,
      status: 'VALIDATED',
    });

    expect(entry.ipAddress).toBe(REQUEST.ip);
    expect(entry.userAgent).toBe(REQUEST.userAgent);
  });

  it('removes only the leads this batch carried', async () => {
    const keep = await seedBatch(admin.id, { leadNoPrefix: 'KEEP' });
    const drop = await seedBatch(admin.id, { leadNoPrefix: 'DROP' });

    const result = await deleteBatchAction({ batchId: drop.batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Reported rather than inferred: leads are upserted on `lead_no`, so this
    // count can include a lead an earlier workbook also carried, and an admin
    // who is not shown the number discovers it in the leads list instead.
    expect(result.data.leadsRemoved).toBe(2);

    const remaining = await db.select({ leadNo: lead.leadNo }).from(lead);
    expect(remaining.map((row) => row.leadNo).sort()).toEqual(['KEEP-1', 'KEEP-2']);
    expect(await survivors(keep.batchId)).toEqual(INTACT);
    expect(existsSync(keep.absolutePath)).toBe(true);
  });
});

describe('a stored file that has already gone', () => {
  it('still deletes the row, and reports the workbook as orphaned rather than failing', async () => {
    const seeded = await seedBatch(admin.id);
    await unlink(seeded.absolutePath);

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The row is gone, so the upload is gone from the admin's point of view.
    // Calling the whole delete failed would invite a retry that can no longer do
    // anything, and would leave them believing the batch is still there.
    expect(result.data).toEqual({ leadsRemoved: 2, fileRemoved: false, recordsRemoved: 0 });
    expect(await survivors(seeded.batchId)).toEqual(GONE);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'UPLOAD_DELETE'));
    expect(entry.before).toMatchObject({ storedPath: seeded.storedPath });
  });
});

/**
 * Removing a committed upload — the destructive path, spec §4 (2026-08-06).
 *
 * A committed batch cannot simply be dropped: every record it created points
 * back at it. The honest reading of "delete it" is therefore to take those
 * records too, which is a different act from deleting a draft and is gated
 * accordingly.
 */
describe('purging a committed upload', () => {
  async function seedCommittedWithRecord() {
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });
    const [record] = await db
      .insert(salesRecord)
      .values({
        appsNo: `PURGE-${randomUUID().slice(0, 8)}`,
        smId: SM_CODE,
        status: 'ISSUED',
        sourceBatchId: seeded.batchId,
        sourceRowNumber: 2,
      })
      .returning();
    return { seeded, record };
  }

  it('asks for the record count before destroying anything', async () => {
    const { seeded } = await seedCommittedWithRecord();

    const result = await deleteBatchAction({ batchId: seeded.batchId, purge: true });

    expect(result.ok).toBe(false);
    // The number is IN the refusal, because it is what the admin has to type
    // back — asking them to go and count it themselves would guarantee they
    // guess.
    if (!result.ok) expect(result.error).toMatch(/Type 1 to confirm/);
    expect(await db.select().from(salesRecord)).toHaveLength(1);
  });

  it('takes the records with it once the count is confirmed', async () => {
    const { seeded } = await seedCommittedWithRecord();

    const result = await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      confirm: '1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.recordsRemoved).toBe(1);

    expect(await db.select().from(salesRecord)).toHaveLength(0);
    expect(await db.select().from(uploadBatch).where(eq(uploadBatch.id, seeded.batchId))).toHaveLength(0);
    expect(existsSync(seeded.absolutePath)).toBe(false);
  });

  it('takes the roster this upload wrote with it — clean in, clean out', async () => {
    const { seeded } = await seedCommittedWithRecord();
    await db.insert(manpower).values({
      smId: SM_CODE,
      tlId: 'TL001',
      ccmId: 'CCM001',
      sourceBatchId: seeded.batchId,
      isOrphan: false,
    });

    await deleteBatchAction({ batchId: seeded.batchId, purge: true, confirm: '1' });

    // Deleting an upload removes exactly what it created, roster included.
    // Keeping the placements would leave a reporting line whose source file no
    // longer exists, so a re-import of a corrected sheet would merge into stale
    // rows nobody could account for.
    expect(await db.select().from(manpower).where(eq(manpower.smId, SM_CODE))).toHaveLength(0);
  });

  it('leaves an admin override alone — it is a decision about a person, not a row this file wrote', async () => {
    const { seeded } = await seedCommittedWithRecord();
    await db.insert(manpower).values({
      smId: SM_CODE,
      tlId: 'TL001',
      ccmId: 'CCM001',
      sourceBatchId: seeded.batchId,
      isOrphan: false,
    });
    await db.insert(manpowerOverride).values({
      smId: SM_CODE,
      tlId: 'TL999',
      ccmId: 'CCM999',
      overriddenBy: admin.id,
    });

    await deleteBatchAction({ batchId: seeded.batchId, purge: true, confirm: '1' });

    // `manpower_override` carries no batch reference on purpose: the pin applies
    // again the moment that rep is re-imported.
    const [override] = await db
      .select()
      .from(manpowerOverride)
      .where(eq(manpowerOverride.smId, SM_CODE));
    expect(override).toBeDefined();
    expect(override.tlId).toBe('TL999');
  });

  it('refuses when an approved correction would be erased with the records', async () => {
    const { seeded, record } = await seedCommittedWithRecord();

    await db.insert(correctionRequest).values({
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      proposedValue: 'Yes',
      submittedBy: admin.id,
      smId: SM_CODE,
      status: 'APPROVED',
    });

    const result = await deleteBatchAction({ batchId: seeded.batchId, purge: true, confirm: '1' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/approved correction/i);
    // An approved correction is an audited decision about a record. Nothing is
    // removed rather than erasing it along with the version it produced.
    expect(await db.select().from(salesRecord)).toHaveLength(1);
    expect(await db.select().from(uploadBatch).where(eq(uploadBatch.id, seeded.batchId))).toHaveLength(1);
  });
});

/**
 * Forcing past the approved-correction guard.
 *
 * "Withdraw them first" is not always a route that is open — a period closes, an
 * approver leaves — so the wrong workbook, committed, would otherwise sit in the
 * list forever. The override exists for that, and everything below is about the
 * price it charges: two confirmations, and an audit entry that carries the
 * decisions themselves, because after the cascade there is nothing left to join
 * to.
 */
describe('forcing a delete past an approved correction', () => {
  async function seedApproved() {
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });
    const [record] = await db
      .insert(salesRecord)
      .values({
        appsNo: `FORCE-${randomUUID().slice(0, 8)}`,
        smId: SM_CODE,
        status: 'ISSUED',
        sourceBatchId: seeded.batchId,
        sourceRowNumber: 2,
      })
      .returning();

    const [correction] = await db
      .insert(correctionRequest)
      .values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'AUTOPAY',
        fieldName: 'autopay',
        fieldLabel: 'AutoPay',
        originalValue: 'No',
        proposedValue: 'Yes',
        submittedBy: admin.id,
        smId: SM_CODE,
        status: 'APPROVED',
        reviewedBy: admin.id,
        reviewedAt: new Date(),
        appliedVersion: 2,
      })
      .returning();

    return { seeded, record, correction };
  }

  it('offers the override in the refusal itself, so the panel can find it without reading the sentence', async () => {
    const { seeded } = await seedApproved();

    const result = await deleteBatchAction({ batchId: seeded.batchId, purge: true, confirm: '1' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The panel offers "Force delete" off this key alone. Matching the wording
    // instead would put the rule in two places and lose the override the first
    // time somebody rewrites the copy.
    expect(result.fieldErrors?.force).toEqual(['1']);
    // Singular agreement, because the sentence names a real number and "1
    // approved correction have been applied" is the first thing an admin reads
    // at the most consequential moment in the app.
    expect(result.error).toMatch(/1 approved correction has been applied/);
  });

  it('still refuses with the flag alone — the phrase is a second decision, not a louder click', async () => {
    const { seeded } = await seedApproved();

    const result = await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      confirm: '1',
      force: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Type ERASE APPROVALS to confirm/);

    expect(await db.select().from(salesRecord)).toHaveLength(1);
    expect(await db.select().from(correctionRequest)).toHaveLength(1);
    // The audit write sits after the guards, so a refused force leaves no record
    // of a deletion that never happened.
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses the phrase without the record count too — both gates hold', async () => {
    const { seeded } = await seedApproved();

    const result = await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      force: true,
      forceConfirm: 'ERASE APPROVALS',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Type 1 to confirm/);
    expect(await db.select().from(salesRecord)).toHaveLength(1);
  });

  it('takes the approved correction with the records once both are typed', async () => {
    const { seeded } = await seedApproved();

    const result = await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      confirm: '1',
      // Case and padding are forgiven: the box renders uppercase, and being
      // refused for typing exactly what the screen said is how an admin
      // concludes the override is broken and asks for the row to be deleted by
      // hand instead.
      force: true,
      forceConfirm: '  erase approvals ',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.recordsRemoved).toBe(1);

    // `correction_request.record_id` is ON DELETE CASCADE, so the decision goes
    // out with the record it was about.
    expect(await db.select().from(correctionRequest)).toHaveLength(0);
    expect(await db.select().from(salesRecord)).toHaveLength(0);
    expect(await survivors(seeded.batchId)).toEqual(GONE);
    expect(existsSync(seeded.absolutePath)).toBe(false);
  });

  it('writes the erased decisions into an audit entry of its own', async () => {
    const { seeded, correction, record } = await seedApproved();

    await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      confirm: '1',
      force: true,
      forceConfirm: 'ERASE APPROVALS',
    });

    // A distinct action, not a flag on UPLOAD_DELETE: "which approvals has an
    // admin overridden" is unanswerable if the two share a name.
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, 'UPLOAD_DELETE_FORCED'));
    expect(entries).toHaveLength(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'UPLOAD_DELETE'))).toHaveLength(0);

    // The decision in full, because `correction_request` no longer has a row to
    // join to and this entry is the only place it ever happened.
    expect(entries[0].metadata).toMatchObject({
      erasedApprovals: [
        {
          id: correction.id,
          appsNo: record.appsNo,
          fieldLabel: 'AutoPay',
          originalValue: 'No',
          proposedValue: 'Yes',
          reviewedBy: admin.id,
          appliedVersion: 2,
        },
      ],
    });
    expect(entries[0].entityId).toBe(seeded.batchId);
  });

  it('leaves the ordinary action name on a purge with nothing to override', async () => {
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });
    await db.insert(salesRecord).values({
      appsNo: `PLAIN-${randomUUID().slice(0, 8)}`,
      smId: SM_CODE,
      status: 'ISSUED',
      sourceBatchId: seeded.batchId,
      sourceRowNumber: 2,
    });

    // The flag and the phrase are both present and both irrelevant. A purge that
    // erases no approval is not a forced delete, and recording it as one would
    // make the filter that finds real overrides useless.
    await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      confirm: '1',
      force: true,
      forceConfirm: 'ERASE APPROVALS',
    });

    const [entry] = await db.select().from(auditLog);
    expect(entry.action).toBe('UPLOAD_DELETE');
    expect(entry.metadata).toBeNull();
  });

  it('does not let the force past any other refusal', async () => {
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });
    await db.insert(ingestJob).values({ kind: 'PARSE', status: 'RUNNING', batchId: seeded.batchId });

    const result = await deleteBatchAction({
      batchId: seeded.batchId,
      purge: true,
      confirm: '0',
      force: true,
      forceConfirm: 'ERASE APPROVALS',
    });

    expect(result.ok).toBe(false);
    // A worker still holds this batch's id. The override is about approved
    // corrections and nothing else — it is not an admin-knows-best switch.
    if (!result.ok) expect(result.error).toMatch(/parse is still running/i);
    expect(await db.select().from(uploadBatch).where(eq(uploadBatch.id, seeded.batchId))).toHaveLength(1);
  });
});

describe('deletions the action refuses', () => {
  it('refuses a committed upload without the purge flag, and leaves every part of it in place', async () => {
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(false);
    // The refusal has to name the routes that ARE open, or the admin's next move
    // is to try again rather than to pick one of them.
    if (!result.ok) expect(result.error).toMatch(/correction request/i);

    expect(await survivors(seeded.batchId)).toEqual(INTACT);
    expect(existsSync(seeded.absolutePath)).toBe(true);
    // The audit write sits after the guards, so a refusal leaves no record of a
    // deletion that never happened.
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('is refusing what the database would refuse anyway, in a sentence instead of a constraint name', async () => {
    // The guard above is not defence in depth over a constraint that does not
    // exist — it is a translation of one. Remove it as redundant and the admin
    // gets Postgres's wording for the most consequential refusal in the app.
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });
    await db.insert(salesRecord).values({
      appsNo: '5920000001',
      smId: SM_CODE,
      status: 'ISSUED',
      sourceBatchId: seeded.batchId,
      sourceRowNumber: 2,
    });

    // Clearing the leads first is what the action's own transaction does, so what
    // remains is exactly the delete it would attempt — and it still fails.
    await db.delete(lead).where(eq(lead.sourceBatchId, seeded.batchId));

    await expectDbError(
      db.delete(uploadBatch).where(eq(uploadBatch.id, seeded.batchId)),
      /still referenced from table "sales_record"/,
    );
  });

  it('refuses while the parse for the batch is still queued', async () => {
    const seeded = await seedBatch(admin.id);
    await db.insert(ingestJob).values({ kind: 'PARSE', status: 'QUEUED', batchId: seeded.batchId });

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/parse is still running/i);

    // A worker holds this batch's id. Cascading its job row out from under it
    // turns its next progress write into a foreign-key error against a batch that
    // is not there, which the admin then has to interpret.
    expect(await survivors(seeded.batchId)).toEqual({ ...INTACT, jobs: 3 });
    expect(existsSync(seeded.absolutePath)).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('names the Lead Dump import and the stage it is on when that is what is running', async () => {
    const seeded = await seedBatch(admin.id);
    await db.insert(ingestJob).values({
      kind: 'LEADS',
      status: 'RUNNING',
      batchId: seeded.batchId,
      stage: 'streaming Lead Dump',
      done: 12_000,
    });

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(false);
    // "Wait for it to finish" is only actionable if the admin can tell which of
    // the two jobs to wait for. A Lead Dump pass over 54,507 rows and a parse are
    // minutes apart in how long that wait is.
    if (!result.ok) {
      expect(result.error).toMatch(
        /Lead Dump import is still running for this upload \(streaming Lead Dump\)/,
      );
    }

    expect(await survivors(seeded.batchId)).toEqual({ ...INTACT, jobs: 3 });
  });

  it('refuses an id that names no upload, and one that is not an id at all', async () => {
    const gone = await deleteBatchAction({ batchId: randomUUID() });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.error).toMatch(/no longer exists/i);

    const malformed = await deleteBatchAction({ batchId: 'not-a-uuid' });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toMatch(/unknown batch/i);

    expect(await db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('who may delete an upload', () => {
  it('throws for every role but admin, and for no session at all, removing nothing', async () => {
    const seeded = await seedBatch(admin.id);

    for (const role of ['sales', 'approver', 'verifier'] as const) {
      session.user = sessionFor(await makeUser({ role, smId: role === 'sales' ? SM_CODE : null }));
      // AuthzError propagates rather than becoming a result: the layout catches
      // it and redirects. A `fail(...)` here would render a red box on a page the
      // user should not have reached.
      await expect(deleteBatchAction({ batchId: seeded.batchId })).rejects.toBeInstanceOf(AuthzError);
    }

    session.user = null;
    await expect(deleteBatchAction({ batchId: seeded.batchId })).rejects.toBeInstanceOf(AuthzError);

    // The middleware redirects too, but it is not the authorization boundary —
    // spec section 4.1. This is the check that has to hold when the action is
    // invoked directly.
    expect(await survivors(seeded.batchId)).toEqual(INTACT);
    expect(existsSync(seeded.absolutePath)).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a deactivated admin', async () => {
    const seeded = await seedBatch(admin.id);
    session.user = { ...admin, isActive: false };

    await expect(deleteBatchAction({ batchId: seeded.batchId })).rejects.toBeInstanceOf(AuthzError);
    expect(await survivors(seeded.batchId)).toEqual(INTACT);
  });
});
