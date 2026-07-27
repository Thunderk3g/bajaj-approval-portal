'use server';

import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { uploadBatch } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { requireRole } from '@/lib/auth/rbac';
import { fail, ok, zodFieldErrors, type ActionResult } from '@/lib/result';
import { allocateStoragePath, ensureStorageDirs, resolveStoredPath, UPLOADS_DIR } from '@/lib/storage/paths';
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
 */

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

/** Formats SheetJS can read here. `.xlsb` is the one the real source uses. */
const ALLOWED_EXTENSIONS = new Set(['.xlsb', '.xlsx', '.xlsm', '.xls']);

/**
 * The leading bytes each accepted container must actually start with.
 *
 * The extension alone is a claim made by whoever named the file. Checking the
 * signature costs four bytes and stops the storage directory accumulating
 * things that are not workbooks at all.
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

  let sheetNames: string[];
  try {
    sheetNames = listSheets(bytes).map((s) => s.name);
  } catch {
    await unlink(absolutePath).catch(() => undefined);
    return fail('That workbook could not be opened.', {
      file: ['SheetJS could not read the file. It may be corrupt or password-protected.'],
    });
  }

  const [batch] = await db
    .insert(uploadBatch)
    .values({
      originalFileName: file.name,
      storedPath: relativePath,
      fileHash,
      uploadedBy: actor.id,
      notes: (formData.get('notes') as string | null)?.trim() || null,
    })
    .returning({ id: uploadBatch.id });

  await writeAudit({
    actor,
    action: 'UPLOAD_CREATE',
    entityType: 'upload_batch',
    entityId: batch.id,
    after: { originalFileName: file.name, fileHash, sizeBytes: bytes.byteLength, sheetNames },
    metadata: { duplicateOfBatchId: existing?.id ?? null },
    ...context,
  });

  revalidatePath('/admin/uploads');
  return ok({ batchId: batch.id, duplicateOfBatchId: existing?.id ?? null });
}

/* ------------------------------------------------------------------- sheet */

const sheetSchema = z.object({
  batchId: z.string().uuid(),
  sheetName: z.string().min(1, 'Choose a sheet.'),
  headerRow: z.coerce.number().int().min(1, 'The header row must be 1 or greater.').max(1000),
  dateFormat: z.enum(DATE_FORMATS),
});

export async function setBatchSheetAction(
  input: unknown,
): Promise<ActionResult<{ columns: number }>> {
  const actor = await requireRole('admin');
  const context = await requestContext();

  const parsed = sheetSchema.safeParse(input);
  if (!parsed.success) return fail('Check the sheet settings.', zodFieldErrors(parsed.error));

  const batch = await loadEditableBatch(parsed.data.batchId);
  if (!batch.ok) return batch;

  let columnCount: number;
  try {
    const bytes = await readFile(resolveStoredPath(batch.data.storedPath));
    const sheet = readSheet(bytes, {
      sheetName: parsed.data.sheetName,
      headerRow: parsed.data.headerRow,
      maxRows: 1,
    });
    columnCount = sheet.columns.length;
    if (columnCount === 0) {
      return fail('That header row is empty.', {
        headerRow: ['No column names were found on that row. Try a different row number.'],
      });
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'That sheet could not be read.');
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
    metadata: { step: 'sheet' },
    ...context,
  });

  revalidatePath(`/admin/uploads/${parsed.data.batchId}`);
  return ok({ columns: columnCount });
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

  let problems: ReturnType<typeof validateMapping>;
  try {
    const bytes = await readFile(resolveStoredPath(batch.data.storedPath));
    const sheet = readSheet(bytes, {
      sheetName: batch.data.sheetName,
      headerRow: batch.data.headerRow,
      maxRows: 1,
    });
    problems = validateMapping(mapping, sheet.columns);
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'That sheet could not be read.');
  }

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

const batchIdSchema = z.object({ batchId: z.string().uuid() });

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
