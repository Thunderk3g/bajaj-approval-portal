import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  auditLog,
  ingestJob,
  lead,
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
    expect(result.data).toEqual({ leadsRemoved: 2, fileRemoved: true });

    // Three different mechanisms: upload_batch_row and ingest_job go by
    // ON DELETE CASCADE, the leads had to be deleted explicitly, and the file is
    // not in the database at all. Any one of them can regress alone.
    expect(await survivors(seeded.batchId)).toEqual(GONE);
    expect(existsSync(seeded.absolutePath)).toBe(false);
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
    expect(result.data).toEqual({ leadsRemoved: 2, fileRemoved: false });
    expect(await survivors(seeded.batchId)).toEqual(GONE);

    const [entry] = await db.select().from(auditLog).where(eq(auditLog.action, 'UPLOAD_DELETE'));
    expect(entry.before).toMatchObject({ storedPath: seeded.storedPath });
  });
});

describe('deletions the action refuses', () => {
  it('refuses a committed upload and leaves every part of it in place', async () => {
    const seeded = await seedBatch(admin.id, { status: 'COMMITTED' });

    const result = await deleteBatchAction({ batchId: seeded.batchId });

    expect(result.ok).toBe(false);
    // The refusal has to name the route that IS open, or the admin's next move is
    // to try again rather than to raise a correction.
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
