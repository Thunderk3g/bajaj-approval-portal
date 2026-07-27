import { and, asc, count, desc, eq, gte, inArray, isNotNull, lte, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@/db/client';
import { correctionRequest, excelExport, salesRecord, uploadBatch, user } from '@/db/schema';
import type { ExportCorrection, ExportRecord } from './build';
import { coerceFilters, type ExportFilters } from './schemas';

/** Reads. Every one of them assumes the caller has already authorized. */

/**
 * Translates the filter set into SQL — spec section 8.
 *
 * The issued-date bounds compare against a `date` column, so a record with no
 * issuance date drops out of a bounded export. That is correct rather than a
 * bug: a PENDING application has no issuance date to fall inside a range, and
 * including it would put rows in a "records issued in June" workbook that were
 * not issued at all.
 */
export function exportConditions(filters: ExportFilters): SQL | undefined {
  const conditions: SQL[] = [];

  if (filters.batchId) conditions.push(eq(salesRecord.sourceBatchId, filters.batchId));
  if (filters.smId) conditions.push(eq(salesRecord.smId, filters.smId));
  if (filters.issuedFrom) conditions.push(gte(salesRecord.issuedDate, filters.issuedFrom));
  if (filters.issuedTo) conditions.push(lte(salesRecord.issuedDate, filters.issuedTo));
  if (filters.correctedOnly) conditions.push(eq(salesRecord.hasCorrections, true));

  return conditions.length ? and(...conditions) : undefined;
}

export async function fetchExportRecords(filters: ExportFilters): Promise<ExportRecord[]> {
  return db
    .select()
    .from(salesRecord)
    .where(exportConditions(filters))
    .orderBy(asc(salesRecord.appsNo));
}

/**
 * Postgres accepts at most 65535 bind parameters per statement, and one UUID
 * per exported record would blow through that on a large book. Chunking keeps
 * the query legal without an arbitrary cap on export size.
 */
const ID_CHUNK = 1000;

/**
 * The applied corrections behind the exported rows.
 *
 * Scoped by record id rather than by re-running the record filter, so the two
 * result sets are consistent by construction: a record that appeared in the
 * first query but was corrected between the two reads cannot contribute a
 * correction row for a record that is not in the sheet.
 *
 * `applied_at IS NOT NULL` alongside APPROVED is not redundant. Spec 7.3 sets
 * both in one transaction, so a row with a decision but no application would
 * mean the update never landed — annotating a cell from it would claim a change
 * the record does not carry.
 */
export async function fetchAppliedCorrections(recordIds: string[]): Promise<ExportCorrection[]> {
  if (recordIds.length === 0) return [];

  const submitter = alias(user, 'submitter');
  const reviewer = alias(user, 'reviewer');

  const results: ExportCorrection[] = [];

  for (let offset = 0; offset < recordIds.length; offset += ID_CHUNK) {
    const chunk = recordIds.slice(offset, offset + ID_CHUNK);

    const rows = await db
      .select({
        id: correctionRequest.id,
        recordId: correctionRequest.recordId,
        appsNo: correctionRequest.appsNo,
        category: correctionRequest.category,
        fieldName: correctionRequest.fieldName,
        fieldLabel: correctionRequest.fieldLabel,
        originalValue: correctionRequest.originalValue,
        proposedValue: correctionRequest.proposedValue,
        description: correctionRequest.description,
        smId: correctionRequest.smId,
        submittedAt: correctionRequest.submittedAt,
        status: correctionRequest.status,
        approverRemarks: correctionRequest.approverRemarks,
        reviewedAt: correctionRequest.reviewedAt,
        appliedAt: correctionRequest.appliedAt,
        submitterName: submitter.name,
        submitterEmail: submitter.email,
        approverName: reviewer.name,
        approverEmail: reviewer.email,
      })
      .from(correctionRequest)
      .leftJoin(submitter, eq(submitter.id, correctionRequest.submittedBy))
      .leftJoin(reviewer, eq(reviewer.id, correctionRequest.reviewedBy))
      .where(
        and(
          eq(correctionRequest.status, 'APPROVED'),
          isNotNull(correctionRequest.appliedAt),
          inArray(correctionRequest.recordId, chunk),
        ),
      )
      .orderBy(asc(correctionRequest.appsNo), asc(correctionRequest.appliedAt));

    results.push(...rows);
  }

  return results;
}

/**
 * The `v<n>` suffix of the next filename — spec section 8.
 *
 * Counting rows, not reading a sequence, because the column the spec asks for
 * does not exist and the schema is fixed. Two concurrent generations can
 * therefore land on the same `n`; the name is cosmetic and the stored path is a
 * UUID, so the collision is a duplicated label and never a lost file.
 */
export async function nextExportVersion(): Promise<number> {
  const [row] = await db.select({ total: count() }).from(excelExport);
  return (row?.total ?? 0) + 1;
}

/** Names the source batch for the `Export Info` sheet. */
export async function batchLabel(batchId: string | null): Promise<string | null> {
  if (!batchId) return null;

  const [row] = await db
    .select({ name: uploadBatch.originalFileName, uploadedAt: uploadBatch.uploadedAt })
    .from(uploadBatch)
    .where(eq(uploadBatch.id, batchId))
    .limit(1);

  if (!row) return batchId;
  return `${row.name} (uploaded ${row.uploadedAt.toISOString().slice(0, 10)})`;
}

/** Committed batches only: an uncommitted batch has no rows in `sales_record` to export. */
export async function committedBatches() {
  return db
    .select({
      id: uploadBatch.id,
      name: uploadBatch.originalFileName,
      committedAt: uploadBatch.committedAt,
    })
    .from(uploadBatch)
    .where(eq(uploadBatch.status, 'COMMITTED'))
    .orderBy(desc(uploadBatch.uploadedAt))
    .limit(100);
}

export type PastExport = {
  id: string;
  fileName: string;
  rowCount: number;
  correctionCount: number;
  downloadCount: number;
  createdAt: Date;
  requestedByName: string | null;
  requestedByEmail: string | null;
  filters: ExportFilters;
};

export async function listExports(limit = 50): Promise<PastExport[]> {
  const rows = await db
    .select({
      id: excelExport.id,
      fileName: excelExport.fileName,
      rowCount: excelExport.rowCount,
      correctionCount: excelExport.correctionCount,
      downloadCount: excelExport.downloadCount,
      createdAt: excelExport.createdAt,
      filters: excelExport.filters,
      requestedByName: user.name,
      requestedByEmail: user.email,
    })
    .from(excelExport)
    .leftJoin(user, eq(user.id, excelExport.requestedBy))
    .orderBy(desc(excelExport.createdAt))
    .limit(limit);

  return rows.map((row) => ({ ...row, filters: coerceFilters(row.filters) }));
}
