'use server';

import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { ingestJob, lead, uploadBatch } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { allocateStoragePath, ensureStorageDirs, resolveStoredPath, UPLOADS_DIR } from '@/lib/storage/paths';
import { isPeriodCode, periodCodeFor } from '@/lib/periods/service';
import { IngestError, startLeadsJob, startParseJob, toSourceColumns } from '@/lib/ingest/client';
import { latestParseJob, parseResultOf } from '@/lib/ingest/queries';
import { DATE_FORMATS, DEFAULT_DATE_FORMAT, type DateFormat } from './dates';
import { commitBatch } from './commit';
import { validateMapping } from './mapping';
import { listSheets, readSheet, MANPOWER_SHEET, MAPPING_CHANGES_SHEET } from './parse';
import { loadMasterSnapshots, stageRows } from './stage';
import { buildValidationReport, validateRows } from './validate';
import type { ColumnMapping, CommitOutcome } from './types';

/**
 * Server Actions for the import pipeline.
 *
 * Every one of them calls `requireRole('admin')` itself. Spec section 4.1: the
 * middleware redirects, but it is NOT the authorization boundary — a directly
 * invoked action, a stale cookie or a middleware bypass has to fail closed on
 * its own, and it only does that if the check lives here.
 *
 * AuthzError is deliberately allowed to propagate rather than being folded into
 * an ActionResult: the layout catches it and redirects. Everything else returns
 * a discriminated result, because Next redacts thrown messages in production
 * and "an error occurred" is useless when the real problem is "row 412 has no
 * Apps_No".
 *
 * Reading the workbook is no longer done here — 2026-07-28 ingestion spec
 * section 5. Opening the real 9.14 MB .xlsb with SheetJS costs ~37 s per pass,
 * and doing it inside an action or a render is what made a 4.8 s upload look
 * like a 74.6 s hang. These actions now enqueue a PARSE job with
 * `reconciliation-ingest` and return; the review page renders from the job row.
 */

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/**
 * The sheet that must never be chosen as the transaction sheet.
 *
 * Lower-cased for comparison against a trimmed name — the same comparison the
 * ingestion service's `resolve_sheet` makes, and `isTransactionSheet` in the
 * sheet picker. Three places, one spelling, because a fourth spelling of "lead
 * dump" would silently re-open the failure this closes.
 */
const LEAD_SHEET = 'lead dump';

/** Formats SheetJS can read here. `.xlsb` is the one the real source uses. */
const ALLOWED_EXTENSIONS = new Set(['.xlsb', '.xlsx', '.xlsm', '.xls']);

/**
 * The leading bytes each accepted container must actually start with.
 *
 * The extension alone is a claim made by whoever named the file. Checking the
 * signature costs four bytes and stops the storage directory accumulating
 * things that are not workbooks at all.
 *
 * Since the parse moved to the ingestion service this is the ONLY check made
 * before the file is stored, and that is deliberate: the alternative — opening
 * the workbook here to prove it opens — is the 37-second SheetJS pass this
 * change exists to remove. A file that passes the signature and still cannot be
 * read fails the parse job instead, which the review page reports with the
 * reader's own message.
 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

function matchesMagic(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((byte, i) => bytes[i] === byte);
}

async function requestContext() {
  const headerList = await headers();
  return {
    ipAddress: headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: headerList.get('user-agent'),
  };
}

/**
 * The reconciliation cycle this workbook is for.
 *
 * Falls back to the current calendar month rather than to null. A batch with no
 * period commits records that belong to no cycle, which are then invisible to
 * every period-filtered screen and — worse — unaffected by any close, so
 * corrections against them could be raised forever. The overwhelmingly common
 * case is uploading this month's file this month, so the default is also the
 * right answer nearly every time.
 */
function requestedPeriodCode(formData: FormData): string {
  const raw = (formData.get('periodCode') as string | null)?.trim();
  return raw && isPeriodCode(raw) ? raw : periodCodeFor(new Date());
}

/* ------------------------------------------------------------------ create */

export async function createUploadBatchAction(
  formData: FormData,
): Promise<ActionResult<{ batchId: string; duplicateOfBatchId: string | null }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return fail('Choose a workbook to upload.', { file: ['A file is required.'] });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail('That file is too large.', {
      file: [`Maximum upload size is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`],
    });
  }

  const extension = extname(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return fail('That file type cannot be read.', {
      file: [`Accepted formats: ${[...ALLOWED_EXTENSIONS].join(', ')}.`],
    });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!matchesMagic(bytes, ZIP_MAGIC) && !matchesMagic(bytes, CFB_MAGIC)) {
    return fail('That file is not a readable Excel workbook.', {
      file: ['The file contents do not match its extension.'],
    });
  }

  const fileHash = createHash('sha256').update(bytes).digest('hex');

  // Re-uploading a file already imported is the setup for the section 6.8
  // failure — a stale export quietly reverting approved corrections. It is a
  // warning rather than a refusal, because a re-run after an aborted batch is
  // legitimate, but the admin has to see it before mapping anything.
  const [existing] = await db
    .select({ id: uploadBatch.id, status: uploadBatch.status, uploadedAt: uploadBatch.uploadedAt })
    .from(uploadBatch)
    .where(eq(uploadBatch.fileHash, fileHash))
    .orderBy(desc(uploadBatch.uploadedAt))
    .limit(1);

  await ensureStorageDirs();
  const { absolutePath, relativePath } = await allocateStoragePath(UPLOADS_DIR, extension);
  await writeFile(absolutePath, bytes);

  // The batch row is inserted BEFORE the job is started because
  // `ingest_job.batch_id` is a foreign key to it and the service writes that row
  // itself. There is no window worth worrying about: a batch whose job never
  // started is deleted again below.
  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: file.name,
      storedPath: relativePath,
      fileHash,
      uploadedBy: actor.id,
      notes: (formData.get('notes') as string | null)?.trim() || null,
      // Which monthly cycle this workbook is for — 2026-07-28 spec section 4.3.
      //
      // Defaulted from the form, falling back to the current calendar month.
      // Recorded here rather than only at commit so the review screen can show
      // it and the admin can correct a back-dated file BEFORE the commit closes
      // last month on the strength of it.
      periodCode: requestedPeriodCode(formData),
    })
    .returning({ id: uploadBatch.id });

  let jobId: string;
  try {
    const job = await startParseJob({
      batchId: batch.id,
      storedPath: relativePath,
      headerRow: 1,
      requestedBy: actor.id,
    });
    jobId = job.job_id;
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;

    // Spec section 7: refuse, naming the service. A workbook accepted here and
    // never parsed is worse than one that was never accepted — it sits in the
    // uploads list looking like work in progress, and the admin has no way to
    // tell it apart from a batch someone is midway through mapping.
    //
    // The row and the file both go, in that order: the row is what makes the
    // batch visible, and leaving the file behind would accumulate 9 MB per
    // refused attempt in a directory nothing ever prunes.
    //
    // The delete also covers the narrow case where the service DID create the
    // job and only the reply was lost — `ingest_job.batch_id` cascades, so the
    // orphan job row goes with the batch and its worker's progress writes land
    // on nothing rather than resurrecting a batch the admin was told was
    // refused.
    await db.delete(uploadBatch).where(eq(uploadBatch.id, batch.id));
    await unlink(absolutePath).catch(() => undefined);

    return fail(error.message, {
      file: ['The upload was not accepted. Nothing was stored; try again once the service is up.'],
    });
  }

  await writeAudit({
    actor,
    action: 'UPLOAD_CREATE',
    entityType: 'upload_batch',
    entityId: batch.id,
    after: { originalFileName: file.name, fileHash, sizeBytes: bytes.byteLength },
    // The job id is recorded here rather than on `upload_batch` because there is
    // no column for it and the schema belongs to Drizzle migrations, not to this
    // action. The review page finds the job by `ingest_job.batch_id` instead;
    // this entry is the audit trail linking the two.
    metadata: { duplicateOfBatchId: existing?.id ?? null, parseJobId: jobId },
    ...context,
  });

  revalidatePath('/admin/uploads');
  return ok({ batchId: batch.id, duplicateOfBatchId: existing?.id ?? null });
}

/** Shared by every action whose only input is which batch to act on. */
const batchIdSchema = z.object({ batchId: z.string().uuid() });

/* ------------------------------------------------------------------- sheet */

const sheetSchema = z.object({
  batchId: z.string().uuid(),
  sheetName: z.string().min(1, 'Choose a sheet.'),
  headerRow: z.coerce.number().int().min(1, 'The header row must be 1 or greater.').max(1000),
  dateFormat: z.enum(DATE_FORMATS),
});

/**
 * Records the chosen sheet and re-parses against it.
 *
 * The column count is no longer returned, because proving the header row is
 * non-empty would mean reading the sheet here — the pass this action exists to
 * stop doing. An empty header row now surfaces as a parse job that succeeds with
 * zero columns, which the review page reports in place of the mapping step.
 */
export async function setBatchSheetAction(
  input: unknown,
): Promise<ActionResult<{ jobId: string }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = sheetSchema.safeParse(input);
  if (!parsed.success) return fail('Check the sheet settings.', zodFieldErrors(parsed.error));

  // The picker no longer lists it, but the picker is UI and this is the
  // boundary. Choosing `Lead Dump` as the transaction sheet queues a parse the
  // service refuses outright — reading it through the sheet reader materialises
  // a 54,508 x 16,383 declared range and asks for roughly 28 GB — and the admin
  // gets a FAILED job quoting that number with no hint that the sheet was simply
  // the wrong one. Worse, a batch that reached VALIDATED with this sheet name
  // would send SheetJS down the same path inside `validateBatchAction`, on this
  // process.
  if (parsed.data.sheetName.trim().toLowerCase() === LEAD_SHEET) {
    return fail('Lead Dump is not a transaction sheet.', {
      sheetName: [
        'It carries leads, which have no Apps_No and never join to a record. Import it from the Lead Dump section instead.',
      ],
    });
  }

  const batch = await loadEditableBatch(parsed.data.batchId);
  if (!batch.ok) return batch;

  // The job is started BEFORE the row is updated. If the service is unreachable
  // the batch keeps the sheet it already had, together with the parse result
  // that matches it — recording a sheet whose columns were never read would
  // leave the mapping screen offering the previous sheet's columns under the new
  // sheet's name.
  let jobId: string;
  try {
    const job = await startParseJob({
      batchId: parsed.data.batchId,
      storedPath: batch.data.storedPath,
      sheetName: parsed.data.sheetName,
      headerRow: parsed.data.headerRow,
      requestedBy: actor.id,
    });
    jobId = job.job_id;
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    return fail(error.message);
  }

  // Changing the sheet invalidates any mapping made against the previous one:
  // its column names may not exist here at all.
  await db
    .update(uploadBatch)
    .set({
      sheetName: parsed.data.sheetName,
      headerRow: parsed.data.headerRow,
      dateFormat: parsed.data.dateFormat,
      columnMapping: null,
      validationReport: null,
      status: 'DRAFT',
    })
    .where(eq(uploadBatch.id, parsed.data.batchId));

  await writeAudit({
    actor,
    action: 'UPLOAD_MAPPING_SET',
    entityType: 'upload_batch',
    entityId: parsed.data.batchId,
    after: {
      sheetName: parsed.data.sheetName,
      headerRow: parsed.data.headerRow,
      dateFormat: parsed.data.dateFormat,
    },
    metadata: { step: 'sheet', parseJobId: jobId },
    ...context,
  });

  revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
  return ok({ jobId });
}

/* ----------------------------------------------------------------- reparse */

/**
 * Runs the parse again for a batch whose job failed or never started.
 *
 * Without this a transient outage strands a batch permanently: the file is
 * stored, the row exists, and there is no other route back to a parse result.
 * Spec section 7 keeps the batch DRAFT and the file on disk precisely so that
 * retrying is possible rather than requiring a re-upload of 9 MB.
 */
export async function reparseBatchAction(input: unknown): Promise<ActionResult<{ jobId: string }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = batchIdSchema.safeParse(input);
  if (!parsed.success) return fail('Unknown batch.');

  const batch = await loadEditableBatch(parsed.data.batchId);
  if (!batch.ok) return batch;

  try {
    const job = await startParseJob({
      batchId: parsed.data.batchId,
      storedPath: batch.data.storedPath,
      sheetName: batch.data.sheetName,
      headerRow: batch.data.headerRow,
      requestedBy: actor.id,
    });

    await writeAudit({
      actor,
      action: 'UPLOAD_MAPPING_SET',
      entityType: 'upload_batch',
      entityId: parsed.data.batchId,
      metadata: { step: 'reparse', parseJobId: job.job_id },
      ...context,
    });

    revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
    return ok({ jobId: job.job_id });
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    return fail(error.message);
  }
}

/* ------------------------------------------------------------------- leads */

/**
 * Starts the `Lead Dump` import for a batch — 2026-07-28 ingestion spec section 6.
 *
 * Separate from the transaction import, and deliberately not part of the commit.
 * Leads are a parallel, read-only view: the sheet carries no `Apps_No`, so a lead
 * never joins to a sales record, is not correctable, does not enter the verifier
 * queue and does not participate in the monthly close. Folding it into
 * `commitBatch` would put 54,507 upserts inside the transaction that writes the
 * master records, so a problem in either would roll back both.
 *
 * Which also means the batch status is not a precondition. Importing leads before
 * the commit is how an admin gets reps their pipeline while the transaction rows
 * are still being reviewed; importing after is equally valid. Only ABORTED is
 * refused — that batch is closed and its file may already be gone.
 */
export async function importLeadsAction(input: unknown): Promise<ActionResult<{ jobId: string }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = batchIdSchema.safeParse(input);
  if (!parsed.success) return fail('Unknown batch.');

  const [batch] = await db
    .select({ id: uploadBatch.id, status: uploadBatch.status, storedPath: uploadBatch.storedPath })
    .from(uploadBatch)
    .where(eq(uploadBatch.id, parsed.data.batchId));

  if (!batch) return fail('That upload no longer exists.');
  if (batch.status === 'ABORTED') return fail('This batch was aborted.');

  // Every lead write is an upsert on `lead_no`, so a second concurrent import
  // would converge rather than duplicate — but it would also spend several
  // minutes of the service's two worker threads racing itself, and the admin
  // would watch two progress bars for one file.
  const [running] = await db
    .select({ id: ingestJob.id })
    .from(ingestJob)
    .where(
      and(
        eq(ingestJob.batchId, batch.id),
        eq(ingestJob.kind, 'LEADS'),
        inArray(ingestJob.status, ['QUEUED', 'RUNNING']),
      ),
    )
    .limit(1);

  if (running) return fail('A Lead Dump import is already running for this upload.');

  try {
    const job = await startLeadsJob({
      batchId: batch.id,
      storedPath: batch.storedPath,
      requestedBy: actor.id,
    });

    await writeAudit({
      actor,
      action: 'UPLOAD_LEADS_IMPORT',
      entityType: 'upload_batch',
      entityId: batch.id,
      metadata: { leadsJobId: job.job_id },
      ...context,
    });

    revalidatePath(`/admin/uploads/${batch.id}`);
    return ok({ jobId: job.job_id });
  } catch (error) {
    if (!(error instanceof IngestError)) throw error;
    return fail(error.message);
  }
}

/* ----------------------------------------------------------------- mapping */

const mappingSchema = z.object({
  batchId: z.string().uuid(),
  mapping: z.record(z.string(), z.string()),
});

export async function setColumnMappingAction(input: unknown): Promise<ActionResult<void>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = mappingSchema.safeParse(input);
  if (!parsed.success) return fail('Check the column mapping.', zodFieldErrors(parsed.error));

  const batch = await loadEditableBatch(parsed.data.batchId);
  if (!batch.ok) return batch;
  if (!batch.data.sheetName) return fail('Choose a sheet before mapping its columns.');

  // A mapping with empty values is how the UI says "leave this field unmapped";
  // those columns go to `extra` rather than being recorded as a mapping.
  const mapping: ColumnMapping = {};
  for (const [fieldKey, columnKey] of Object.entries(parsed.data.mapping)) {
    if (columnKey.trim() !== '') mapping[fieldKey] = columnKey;
  }

  // Validated against the columns the parse job reported, not against a fresh
  // read of the workbook. Those are the same column keys — the service and
  // `buildColumns` emit identical strings by design — and they are the ones the
  // admin was actually shown, so a mapping that looked valid on screen cannot be
  // rejected here by a second reader disagreeing with the first.
  const parseResult = parseResultOf(await latestParseJob(parsed.data.batchId));
  if (!parseResult) {
    return fail('The workbook has not finished parsing yet. Wait for it to complete, then retry.');
  }

  const problems = validateMapping(mapping, toSourceColumns(parseResult.columns));

  if (problems.length > 0) {
    const fieldErrors: Record<string, string[]> = {};
    for (const problem of problems) {
      (fieldErrors[problem.fieldKey ?? '_'] ??= []).push(problem.message);
    }
    return fail('The column mapping is not usable yet.', fieldErrors);
  }

  await db
    .update(uploadBatch)
    .set({ columnMapping: mapping, status: 'MAPPED', validationReport: null })
    .where(eq(uploadBatch.id, parsed.data.batchId));

  await writeAudit({
    actor,
    action: 'UPLOAD_MAPPING_SET',
    entityType: 'upload_batch',
    entityId: parsed.data.batchId,
    before: batch.data.columnMapping,
    after: mapping,
    metadata: { step: 'columns' },
    ...context,
  });

  revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
  return ok();
}

/* ---------------------------------------------------------------- validate */

/**
 * Still reads the workbook with SheetJS, and deliberately so.
 *
 * The ingestion service's PARSE job returns a SAMPLE — eight rows — because that
 * is all the review page needs. Validation needs every row, plus the staging
 * write and the section 6.8 conflict pass against master, and no service
 * endpoint does that yet (spec section 3 assigns it to ingest, but it is not
 * built). Pointing this at `sample_rows` would validate eight rows and commit
 * them as though they were the file.
 *
 * This is not the hang that motivated the 2026-07-28 spec: it runs behind an
 * explicit "Confirm mapping and validate" button with a pending state, not
 * inside a page render, so the admin knows work is happening and what for.
 */
export async function validateBatchAction(
  input: unknown,
): Promise<ActionResult<{ total: number; valid: number; invalid: number; duplicate: number; conflicts: number }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = batchIdSchema.safeParse(input);
  if (!parsed.success) return fail('Unknown batch.');

  const batch = await loadEditableBatch(parsed.data.batchId);
  if (!batch.ok) return batch;
  if (!batch.data.sheetName || !batch.data.columnMapping) {
    return fail('Confirm the sheet and column mapping before validating.');
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolveStoredPath(batch.data.storedPath));
  } catch {
    return fail('The stored workbook could not be read. The upload may need to be repeated.');
  }

  const sheet = readSheet(bytes, {
    sheetName: batch.data.sheetName,
    headerRow: batch.data.headerRow,
  });

  const dateFormat = (batch.data.dateFormat as DateFormat) ?? DEFAULT_DATE_FORMAT;
  const mapping = batch.data.columnMapping as ColumnMapping;

  // Pass 1 normalizes Apps_No so the master lookup can be a single query rather
  // than one per row; pass 2 re-runs with the snapshots in hand so duplicates
  // against master and section 6.8 conflicts are both visible in one report.
  const firstPass = validateRows(sheet.rows, { columns: sheet.columns, mapping, dateFormat });
  const appsNos = firstPass.rows
    .map((r) => r.normalized.appsNo)
    .filter((v): v is string => Boolean(v));

  const existing = await loadMasterSnapshots(appsNos);
  const outcome = validateRows(sheet.rows, {
    columns: sheet.columns,
    mapping,
    dateFormat,
    existing,
  });

  const workbookSheets = listSheets(bytes).map((s) => s.name);
  const findSheetNamed = (wanted: string) =>
    workbookSheets.find((n) => n.trim().toLowerCase() === wanted.toLowerCase()) ?? null;

  const report = buildValidationReport(outcome, {
    sheet,
    dateFormat,
    mapping,
    secondarySheets: {
      mappingChanges: findSheetNamed(MAPPING_CHANGES_SHEET),
      manpower: findSheetNamed(MANPOWER_SHEET),
    },
  });

  await db.transaction(async (tx) => {
    await stageRows(parsed.data.batchId, outcome.rows, tx);
    await tx
      .update(uploadBatch)
      .set({
        totalRows: report.totals.rows,
        validRows: report.totals.valid,
        invalidRows: report.totals.invalid,
        duplicateRows: report.totals.duplicate,
        validationReport: report,
        status: 'VALIDATED',
      })
      .where(eq(uploadBatch.id, parsed.data.batchId));
  });

  await writeAudit({
    actor,
    action: 'UPLOAD_VALIDATE',
    entityType: 'upload_batch',
    entityId: parsed.data.batchId,
    after: report.totals,
    metadata: { sheetName: sheet.sheetName, headerRow: sheet.headerRow, dateFormat },
    ...context,
  });

  revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
  return ok({
    total: report.totals.rows,
    valid: report.totals.valid,
    invalid: report.totals.invalid,
    duplicate: report.totals.duplicate,
    conflicts: report.totals.conflicts,
  });
}

/* ------------------------------------------------------------------ commit */

const commitSchema = z.object({
  batchId: z.string().uuid(),
  /** Apps_No -> canonical field keys the admin accepted from the file (6.8). */
  acceptedConflicts: z.record(z.string(), z.array(z.string())).optional(),
});

export async function commitBatchAction(input: unknown): Promise<ActionResult<CommitOutcome>> {
  const actor = await requireRole('admin');

  const parsed = commitSchema.safeParse(input);
  if (!parsed.success) return fail('Unknown batch.');

  try {
    const outcome = await commitBatch({
      batchId: parsed.data.batchId,
      actor,
      acceptedConflicts: parsed.data.acceptedConflicts,
    });

    revalidatePath('/admin/uploads');
    revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
    revalidatePath('/admin/records');
    return ok(outcome);
  } catch (error) {
    // The transaction has already rolled back; nothing partial reached
    // sales_record. FAILED is recorded only when the batch was actually
    // committable — a refusal because the batch was never validated is a
    // precondition, not a failure, and marking it FAILED would strand a batch
    // the admin could simply have validated.
    await db
      .update(uploadBatch)
      .set({ status: 'FAILED' })
      .where(and(eq(uploadBatch.id, parsed.data.batchId), eq(uploadBatch.status, 'VALIDATED')));

    revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
    return fail(error instanceof Error ? error.message : 'The commit failed and was rolled back.');
  }
}

/* ------------------------------------------------------------------- abort */

const abortSchema = z.object({
  batchId: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

export async function abortBatchAction(input: unknown): Promise<ActionResult<void>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = abortSchema.safeParse(input);
  if (!parsed.success) return fail('Unknown batch.');

  const batch = await loadEditableBatch(parsed.data.batchId);
  if (!batch.ok) return batch;

  await db
    .update(uploadBatch)
    .set({ status: 'ABORTED', notes: parsed.data.reason ?? batch.data.notes })
    .where(eq(uploadBatch.id, parsed.data.batchId));

  await writeAudit({
    actor,
    action: 'UPLOAD_ABORT',
    entityType: 'upload_batch',
    entityId: parsed.data.batchId,
    before: { status: batch.data.status },
    after: { status: 'ABORTED' },
    metadata: { reason: parsed.data.reason ?? null },
    ...context,
  });

  revalidatePath('/admin/uploads');
  revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
  return ok();
}

/* ------------------------------------------------------------------ delete */

/**
 * Removes an upload entirely: the batch row, everything staged from it, and the
 * stored workbook on disk.
 *
 * Distinct from {@link abortBatchAction}, which keeps all three and only marks
 * the batch closed. Abort is the right answer for a real import that went wrong
 * and should stay in the record; this is for a file that should not be in the
 * list at all — a test upload, the wrong workbook, a duplicate.
 *
 * A COMMITTED batch is refused, and the database would refuse it too:
 * `sales_record.source_batch_id`, `sales_record_version.batch_id` and
 * `manpower.source_batch_id` all reference it without ON DELETE, so the delete
 * raises a foreign-key violation rather than quietly detaching the provenance of
 * live records. The check here exists to say WHY in a sentence rather than
 * letting Postgres say it in a constraint name.
 */
const deleteSchema = z.object({ batchId: z.string().uuid() });

export async function deleteBatchAction(
  input: unknown,
): Promise<ActionResult<{ leadsRemoved: number; fileRemoved: boolean }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) return fail('Unknown batch.');

  const [batch] = await db.select().from(uploadBatch).where(eq(uploadBatch.id, parsed.data.batchId));
  if (!batch) return fail('That upload no longer exists.');

  if (batch.status === 'COMMITTED') {
    return fail(
      'A committed upload cannot be deleted. Its rows are the provenance of live records — ' +
        'every record it created points back at it, as does every version snapshot. ' +
        'Correct the data through a correction request instead.',
    );
  }

  // A job still in flight has a worker holding this batch's id. Deleting the row
  // cascades the job row out from under it, and its next write — a progress
  // update, or a lead carrying `source_batch_id` — fails against a batch that is
  // no longer there. Refusing for the ~seconds it takes is better than a job
  // that dies with a foreign-key error the admin has to interpret.
  //
  // This cannot strand a batch: the service reaps jobs whose heartbeat has gone
  // stale (five minutes) to FAILED on startup and by the same rule, so a worker
  // that genuinely died stops blocking the delete on its own.
  const [running] = await db
    .select({ kind: ingestJob.kind, stage: ingestJob.stage })
    .from(ingestJob)
    .where(and(eq(ingestJob.batchId, batch.id), inArray(ingestJob.status, ['QUEUED', 'RUNNING'])))
    .limit(1);

  if (running) {
    return fail(
      `A ${running.kind === 'LEADS' ? 'Lead Dump import' : 'parse'} is still running for this ` +
        `upload${running.stage ? ` (${running.stage})` : ''}. Wait for it to finish, then delete.`,
    );
  }

  // Written BEFORE the delete, not after. `audit_log.entity_id` is plain text
  // with no foreign key precisely so an entry can outlive the thing it describes
  // — which is the entire point of auditing a deletion. Writing it afterwards
  // would mean a crash in between erased the file and left no record of who did
  // it or what it was.
  await writeAudit({
    actor,
    action: 'UPLOAD_DELETE',
    entityType: 'upload_batch',
    entityId: batch.id,
    before: {
      originalFileName: batch.originalFileName,
      fileHash: batch.fileHash,
      status: batch.status,
      sheetName: batch.sheetName,
      totalRows: batch.totalRows,
      uploadedAt: batch.uploadedAt,
      storedPath: batch.storedPath,
    },
    ...context,
  });

  let leadsRemoved = 0;

  try {
    await db.transaction(async (tx) => {
      // Leads do NOT cascade — `lead.source_batch_id` is a plain reference, so
      // the delete below would be refused while any remain. Removing them here
      // is the honest reading of "delete this upload": a lead is a read-only
      // mirror of a Lead Dump row and has no life independent of the file it
      // came from.
      //
      // Note this can remove a lead that ALSO appeared in an earlier workbook:
      // leads are upserted on `lead_no`, so the column names the last batch that
      // carried the lead, not every one that did. Re-importing the earlier file
      // restores them, and the count is returned so the admin sees the number
      // rather than discovering it in the leads list.
      const removed = await tx
        .delete(lead)
        .where(eq(lead.sourceBatchId, batch.id))
        .returning({ id: lead.id });
      leadsRemoved = removed.length;

      // `upload_batch_row` and `ingest_job` are ON DELETE CASCADE and go with it.
      await tx.delete(uploadBatch).where(eq(uploadBatch.id, batch.id));
    });
  } catch (error) {
    // 23503 is a foreign-key violation: something still references this batch
    // that the two steps above did not cover. Naming the constraint is what
    // makes it fixable — a generic "delete failed" would leave an admin with no
    // idea which table is holding it.
    const code = (error as { code?: string })?.code;
    const constraint = (error as { constraint?: string })?.constraint;
    if (code === '23503') {
      return fail(
        `This upload cannot be deleted: other data still refers to it` +
          `${constraint ? ` (${constraint})` : ''}. Nothing was removed.`,
      );
    }
    throw error;
  }

  // The file goes last, and its failure is not the action's failure. The row is
  // already gone, so the upload is gone from the admin's point of view; an
  // orphaned 9 MB file is a housekeeping problem, and reporting the whole delete
  // as failed would invite a retry that can no longer do anything.
  let fileRemoved = true;
  try {
    await unlink(resolveStoredPath(batch.storedPath));
  } catch {
    fileRemoved = false;
  }

  revalidatePath('/admin/uploads');
  revalidatePath('/admin/leads');
  return ok({ leadsRemoved, fileRemoved });
}

/* ------------------------------------------------------------------ shared */

type EditableBatch = typeof uploadBatch.$inferSelect;

/**
 * Loads a batch that is still open to change.
 *
 * A COMMITTED batch is history: re-mapping or re-validating it would rewrite
 * the record of what was actually imported, and the version chain on every
 * record it produced points back at it.
 */
async function loadEditableBatch(batchId: string): Promise<ActionResult<EditableBatch>> {
  const [batch] = await db.select().from(uploadBatch).where(eq(uploadBatch.id, batchId));
  if (!batch) return fail('That upload no longer exists.');
  if (batch.status === 'COMMITTED') return fail('This batch has already been committed.');
  if (batch.status === 'ABORTED') return fail('This batch was aborted.');
  return ok(batch);
}
