import { readFile } from 'node:fs/promises';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  correctionRequest,
  manpower,
  salesRecord,
  salesRecordVersion,
  uploadBatch,
} from '@/db/schema';
import type { DbTransaction } from '@/lib/audit/log';
import { writeAudit } from '@/lib/audit/log';
import type { SessionUser } from '@/lib/auth/rbac';
import { CANONICAL_FIELDS, fieldLabel } from '@/lib/fields';
import { detectGaps } from '@/lib/records/gaps';
import { notifySalesForBatch } from '@/lib/notifications/service';
import { resolveStoredPath } from '@/lib/storage/paths';
import { normalizeIdentifier, normalizeSmId, normalizeString } from './normalize';
import {
  listSheets,
  readManpower,
  readMappingChanges,
  MANPOWER_SHEET,
  MAPPING_CHANGES_SHEET,
  type ManpowerRow,
} from './parse';
import { loadMasterSnapshots, loadStagedRows, markRowsCommitted } from './stage';
import { extraFromRaw } from './validate';
import type { ColumnMapping, CommitOutcome, ConflictAcceptance } from './types';

/**
 * Commit — spec sections 6.6, 6.7 and 6.8, in one transaction.
 *
 * The rule this file exists to enforce: **an import never reverts an approved,
 * evidenced correction.** Someone re-uploading last month's export must not be
 * able to undo a fix that a rep proved and an approver signed off, silently and
 * with no trace. Fields carrying an APPROVED correction are therefore held
 * against the incoming file and the disagreement is escalated to the admin as a
 * CONFLICT; only an explicit per-field acceptance overwrites one, and that
 * writes a REIMPORT version and a RECORD_CONFLICT_RESOLVE audit row.
 *
 * Records are never deleted by an import, and records absent from the file are
 * left untouched.
 */

export type CommitInput = {
  batchId: string;
  actor: SessionUser;
  /** Apps_No -> field keys whose file value the admin explicitly accepted. */
  acceptedConflicts?: ConflictAcceptance;
};

/** The record columns an import is allowed to write, in canonical order. */
type RecordValues = Record<string, string | null>;

function recordValuesFrom(normalized: Record<string, string | null>): RecordValues {
  const values: RecordValues = {};
  for (const field of CANONICAL_FIELDS) values[field.key] = normalized[field.key] ?? null;
  return values;
}

function insertPayload(values: RecordValues) {
  return {
    appsNo: values.appsNo as string,
    policyNo: values.policyNo,
    clientName: values.clientName,
    leadId: values.leadId,
    smId: values.smId as string,
    smName: values.smName,
    tlId: values.tlId,
    tlName: values.tlName,
    ccmId: values.ccmId,
    ccmName: values.ccmName,
    location: values.location,
    loginDate: values.loginDate,
    issuedDate: values.issuedDate,
    fp: values.fp,
    anp: values.anp,
    productName: values.productName,
    productType: values.productType,
    productVariant: values.productVariant,
    bookingFrequency: values.bookingFrequency,
    payMode: values.payMode,
    status: values.status,
    status2: values.status2,
    autopay: values.autopay,
  };
}

function gapsOf(values: RecordValues): string[] {
  return detectGaps({
    status: values.status ?? null,
    issuedDate: values.issuedDate ?? null,
    policyNo: values.policyNo ?? null,
    autopay: values.autopay ?? null,
  });
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Reads the optional secondary sheets before the transaction opens.
 *
 * File I/O inside a transaction holds row locks for the duration of a disk
 * read. These two sheets are small — 292 and 186 rows — but the read cost is
 * unbounded in principle, and there is nothing about it that needs to be
 * transactional.
 */
async function readSecondarySheets(storedPath: string): Promise<{
  mappingChanges: Array<{ appsNo: unknown; smId: unknown }>;
  manpowerRows: ManpowerRow[];
  sheetNames: { mappingChanges: string | null; manpower: string | null };
}> {
  let buffer: Buffer;
  try {
    buffer = await readFile(resolveStoredPath(storedPath));
  } catch {
    // A missing original is a real problem, but it is not a reason to refuse a
    // commit whose rows are already staged in the database.
    return { mappingChanges: [], manpowerRows: [], sheetNames: { mappingChanges: null, manpower: null } };
  }

  const names = listSheets(buffer).map((s) => s.name);
  const find = (wanted: string) =>
    names.find((n) => n.trim().toLowerCase() === wanted.toLowerCase()) ?? null;

  const mappingSheet = find(MAPPING_CHANGES_SHEET);
  const manpowerSheet = find(MANPOWER_SHEET);

  return {
    mappingChanges: mappingSheet ? readMappingChanges(buffer, mappingSheet) : [],
    manpowerRows: manpowerSheet ? readManpower(buffer, manpowerSheet) : [],
    sheetNames: { mappingChanges: mappingSheet, manpower: manpowerSheet },
  };
}

export async function commitBatch(input: CommitInput): Promise<CommitOutcome> {
  const [batch] = await db.select().from(uploadBatch).where(eq(uploadBatch.id, input.batchId));
  if (!batch) throw new Error('Batch not found');
  if (batch.status !== 'VALIDATED') {
    throw new Error(`Batch must be validated before commit (it is ${batch.status})`);
  }

  const secondary = await readSecondarySheets(batch.storedPath);
  const mapping = (batch.columnMapping ?? {}) as ColumnMapping;
  const accepted = input.acceptedConflicts ?? {};

  return db.transaction(async (tx) => {
    // FOR UPDATE, re-reading status inside the transaction: two admins pressing
    // Commit at the same moment would otherwise each see VALIDATED and both
    // write, producing two version chains and one lost update.
    const [locked] = await tx
      .select({ id: uploadBatch.id, status: uploadBatch.status })
      .from(uploadBatch)
      .where(eq(uploadBatch.id, input.batchId))
      .for('update');

    if (!locked || locked.status !== 'VALIDATED') {
      throw new Error('Batch is no longer in a committable state');
    }

    const staged = await loadStagedRows(input.batchId, { onlyCommittable: true }, tx);
    const appsNos = staged.map((r) => r.normalized.appsNo).filter((v): v is string => Boolean(v));
    const snapshots = await loadMasterSnapshots(appsNos, tx);

    const outcome: CommitOutcome = {
      inserted: 0,
      updated: 0,
      skipped: 0,
      conflictsResolved: 0,
      conflictsHeld: 0,
      mappingChangesApplied: 0,
      mappingChangesUnmatched: 0,
      manpowerUpserted: 0,
      orphanSmIds: [],
      notified: 0,
    };

    const committedRowIds: string[] = [];
    const gapCountBySmId = new Map<string, number>();
    const smIdsSeen = new Set<string>();

    const countGaps = (values: RecordValues) => {
      const smId = values.smId;
      if (!smId) return;
      smIdsSeen.add(smId);
      if (gapsOf(values).length > 0) {
        gapCountBySmId.set(smId, (gapCountBySmId.get(smId) ?? 0) + 1);
      }
    };

    for (const row of staged) {
      const values = recordValuesFrom(row.normalized);
      const appsNo = values.appsNo;
      const smId = values.smId;

      // Staging already classified these as INVALID, but the guard stays: a
      // NOT NULL violation mid-transaction would roll back the whole batch.
      if (!appsNo || !smId) {
        outcome.skipped += 1;
        continue;
      }

      const extra = extraFromRaw(row.raw, mapping);
      const snapshot = snapshots.get(appsNo);

      if (!snapshot) {
        const [created] = await tx
          .insert(salesRecord)
          .values({
            ...insertPayload(values),
            extra,
            sourceBatchId: input.batchId,
            sourceRowNumber: row.rowNumber,
            currentVersion: 1,
          })
          .returning();

        // Version 1 is the untouched imported row (spec section 5.5). Together
        // with the stored workbook it means the original survives two
        // independent ways before a single correction is ever raised.
        await tx.insert(salesRecordVersion).values({
          recordId: created.id,
          version: 1,
          data: created,
          changeType: 'IMPORT',
          changedFields: null,
          changedBy: input.actor.id,
          batchId: input.batchId,
          note: `Imported from ${batch.originalFileName} row ${row.rowNumber}`,
        });

        outcome.inserted += 1;
        committedRowIds.push(row.id);
        countGaps(values);
        continue;
      }

      const acceptedFields = new Set(accepted[appsNo] ?? []);
      const changes: RecordValues = {};
      const changedFields: string[] = [];
      const resolved: Array<{ field: string; from: string | null; to: string | null }> = [];

      for (const field of CANONICAL_FIELDS) {
        const incoming = values[field.key];
        const current = snapshot.values[field.key] ?? null;

        // A blank in the file does not erase a stored value. The source uses a
        // literal "-" for "no value", and 29% of AutoPay is that sentinel — so
        // letting a null overwrite would wipe reconciled data on every
        // re-upload of a stale export. Absence in the file is not an assertion
        // that the field is empty.
        if (incoming === null || incoming === current) continue;

        if (snapshot.protectedFields.includes(field.key)) {
          if (!acceptedFields.has(field.key)) {
            outcome.conflictsHeld += 1;
            continue;
          }
          resolved.push({ field: field.key, from: current, to: incoming });
        }

        changes[field.key] = incoming;
        changedFields.push(field.key);
      }

      if (changedFields.length === 0) {
        // Nothing to write, but the row was still processed and must not be
        // reported as skipped — it simply agreed with what is already stored.
        committedRowIds.push(row.id);
        countGaps({ ...snapshot.values, ...changes });
        continue;
      }

      const nextVersion = await applyRecordUpdate(tx, {
        recordId: snapshot.id,
        changes,
        changedFields,
        extra,
        batchId: input.batchId,
        rowNumber: row.rowNumber,
        actorId: input.actor.id,
        changeType: 'REIMPORT',
        note:
          resolved.length > 0
            ? `Re-import from ${batch.originalFileName}; admin accepted the file value for ${resolved
                .map((r) => fieldLabel(r.field))
                .join(', ')}`
            : `Re-import from ${batch.originalFileName} row ${row.rowNumber}`,
      });

      for (const resolution of resolved) {
        outcome.conflictsResolved += 1;
        await writeAudit(
          {
            actor: input.actor,
            action: 'RECORD_CONFLICT_RESOLVE',
            entityType: 'sales_record',
            entityId: snapshot.id,
            before: { field: resolution.field, value: resolution.from },
            after: { field: resolution.field, value: resolution.to },
            metadata: {
              batchId: input.batchId,
              appsNo,
              rowNumber: row.rowNumber,
              version: nextVersion,
              reason: 'Admin accepted the imported value over an approved correction',
            },
          },
          tx,
        );
      }

      outcome.updated += 1;
      committedRowIds.push(row.id);
      countGaps({ ...snapshot.values, ...changes });
    }

    await markRowsCommitted(committedRowIds, tx);

    /* -------------------------------------------- Manpower roster (13.2 n.7) */

    const rosterNames = await upsertManpower(tx, secondary.manpowerRows, input.batchId);
    outcome.manpowerUpserted = rosterNames.size;
    outcome.orphanSmIds = await flagOrphans(tx, smIdsSeen, input.batchId);

    /* ------------------------------------- Mapping Changes Latest (6.7) */

    const mappingResult = await applyMappingChanges(tx, {
      pairs: secondary.mappingChanges,
      actor: input.actor,
      batchId: input.batchId,
      fileName: batch.originalFileName,
    });
    outcome.mappingChangesApplied = mappingResult.applied;
    outcome.mappingChangesUnmatched = mappingResult.unmatched;

    /* ------------------------------------------------------------- close out */

    outcome.notified = await notifySalesForBatch(gapCountBySmId, batch.originalFileName, tx);

    await tx
      .update(uploadBatch)
      .set({
        status: 'COMMITTED',
        committedBy: input.actor.id,
        committedAt: new Date(),
      })
      .where(eq(uploadBatch.id, input.batchId));

    await writeAudit(
      {
        actor: input.actor,
        action: 'UPLOAD_COMMIT',
        entityType: 'upload_batch',
        entityId: input.batchId,
        after: outcome,
        metadata: {
          fileName: batch.originalFileName,
          sheetName: batch.sheetName,
          fileHash: batch.fileHash,
          secondarySheets: secondary.sheetNames,
        },
      },
      tx,
    );

    return outcome;
  });
}

/**
 * Writes one record change plus its version row and returns the new version.
 *
 * Version rows hold the state of the record AT that version — v1 is the
 * imported row, vN is what the record became after change N. The alternative
 * (storing the pre-change state) makes `current_version` disagree with the
 * highest version row and leaves the newest state recorded nowhere but the
 * mutable table itself.
 */
async function applyRecordUpdate(
  tx: DbTransaction,
  args: {
    recordId: string;
    changes: RecordValues;
    changedFields: string[];
    extra?: Record<string, unknown>;
    batchId: string | null;
    rowNumber?: number | null;
    actorId: string;
    changeType: 'IMPORT' | 'CORRECTION' | 'REIMPORT' | 'ADMIN_EDIT';
    note: string;
    correctionRequestId?: string | null;
    markCorrected?: boolean;
  },
): Promise<number> {
  const update: Record<string, unknown> = { ...args.changes, updatedAt: new Date() };

  if (args.extra) {
    // Merged, not replaced: a column present last month and absent this month
    // would otherwise vanish from `extra` on re-import.
    update.extra = sql`${salesRecord.extra} || ${JSON.stringify(args.extra)}::jsonb`;
  }
  if (args.batchId) update.sourceBatchId = args.batchId;
  if (args.rowNumber !== undefined && args.rowNumber !== null) update.sourceRowNumber = args.rowNumber;
  if (args.markCorrected) update.hasCorrections = true;
  update.currentVersion = sql`${salesRecord.currentVersion} + 1`;

  const [updated] = await tx
    .update(salesRecord)
    .set(update)
    .where(eq(salesRecord.id, args.recordId))
    .returning();

  await tx.insert(salesRecordVersion).values({
    recordId: args.recordId,
    version: updated.currentVersion,
    data: updated,
    changeType: args.changeType,
    changedFields: args.changedFields,
    changedBy: args.actorId,
    batchId: args.batchId,
    correctionRequestId: args.correctionRequestId ?? null,
    note: args.note,
  });

  return updated.currentVersion;
}

/**
 * Upserts the `Manpower` roster and returns SM_ID -> SM_Name.
 *
 * The roster is the authority for `sm_name`: approving a mapping claim resolves
 * the gaining rep's name from here rather than trusting free text, because
 * `sm_id` and `sm_name` are never allowed to diverge (spec section 7.2).
 */
async function upsertManpower(
  tx: DbTransaction,
  rows: ManpowerRow[],
  batchId: string,
): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (rows.length === 0) return names;

  const values = [];
  for (const row of rows) {
    const smId = normalizeSmId(row.smId).value;
    if (!smId) continue;
    const smName = normalizeString(row.smName);
    if (names.has(smId)) continue;
    names.set(smId, smName);
    values.push({
      smId,
      smName,
      tlId: normalizeString(row.tlId),
      tlName: normalizeString(row.tlName),
      ccmId: normalizeString(row.ccmId),
      ccmName: normalizeString(row.ccmName),
      location: normalizeString(row.location),
      isOrphan: false,
      sourceBatchId: batchId,
    });
  }

  for (const slice of chunk(values, 200)) {
    await tx
      .insert(manpower)
      .values(slice)
      .onConflictDoUpdate({
        target: manpower.smId,
        set: {
          smName: sql`excluded.sm_name`,
          tlId: sql`excluded.tl_id`,
          tlName: sql`excluded.tl_name`,
          ccmId: sql`excluded.ccm_id`,
          ccmName: sql`excluded.ccm_name`,
          location: sql`excluded.location`,
          // An ID that was only ever seen in transaction data stops being an
          // orphan the moment the roster catches up with it.
          isOrphan: false,
          updatedAt: new Date(),
        },
      });
  }

  return names;
}

/**
 * Records SM_IDs seen in the transaction sheet but absent from the roster.
 *
 * Seven exist in the June file, including one purely numeric ID (512454). They
 * are flagged rather than dropped: an orphan still owns real sales, and a
 * provisioning step that assumed the roster was complete would leave those reps
 * unable to see or fix their own book (spec section 13.2 note 7).
 */
async function flagOrphans(
  tx: DbTransaction,
  smIds: Set<string>,
  batchId: string,
): Promise<string[]> {
  if (smIds.size === 0) return [];

  const all = [...smIds];
  const known = new Set<string>();

  for (const slice of chunk(all, 1000)) {
    const rows = await tx
      .select({ smId: manpower.smId })
      .from(manpower)
      .where(inArray(manpower.smId, slice));
    for (const row of rows) known.add(row.smId);
  }

  const orphans = all.filter((id) => !known.has(id));
  if (orphans.length === 0) return [];

  for (const slice of chunk(orphans, 200)) {
    await tx
      .insert(manpower)
      .values(slice.map((smId) => ({ smId, isOrphan: true, sourceBatchId: batchId })))
      .onConflictDoNothing({ target: manpower.smId });
  }

  return orphans;
}

/**
 * Applies the `Mapping Changes Latest` sheet — spec section 6.7.
 *
 * 292 rows of `App Number` -> `SM ID`, all of them prior-month applications
 * with zero overlap with the current transaction sheet. They are imported as
 * pre-approved MAPPING corrections attributed to the uploading admin, so an
 * existing reassignment carries provenance — who moved it, when, and from
 * whom — instead of being retyped by a rep and re-approved from scratch.
 *
 * A pair naming an application this database has never seen is counted and
 * skipped: the master table accumulates across monthly uploads, so the record
 * may simply not have been imported yet.
 */
async function applyMappingChanges(
  tx: DbTransaction,
  args: {
    pairs: Array<{ appsNo: unknown; smId: unknown }>;
    actor: SessionUser;
    batchId: string;
    fileName: string;
  },
): Promise<{ applied: number; unmatched: number }> {
  if (args.pairs.length === 0) return { applied: 0, unmatched: 0 };

  const wanted = new Map<string, string>();
  let unmatched = 0;

  for (const pair of args.pairs) {
    const appsNo = normalizeIdentifier(pair.appsNo, 'appsNo').value;
    const smId = normalizeSmId(pair.smId).value;
    if (!appsNo || !smId) continue;
    // Later rows win: the sheet is named "Latest" and is maintained in place.
    wanted.set(appsNo, smId);
  }

  const found = new Map<string, { id: string; appsNo: string; smId: string; smName: string | null }>();
  for (const slice of chunk([...wanted.keys()], 1000)) {
    const rows = await tx
      .select({
        id: salesRecord.id,
        appsNo: salesRecord.appsNo,
        smId: salesRecord.smId,
        smName: salesRecord.smName,
      })
      .from(salesRecord)
      .where(inArray(salesRecord.appsNo, slice));
    for (const row of rows) found.set(row.appsNo, row);
  }

  const targetSmIds = [...new Set([...wanted.values()])];
  const rosterNames = new Map<string, string | null>();
  for (const slice of chunk(targetSmIds, 1000)) {
    const rows = await tx
      .select({ smId: manpower.smId, smName: manpower.smName })
      .from(manpower)
      .where(inArray(manpower.smId, slice));
    for (const row of rows) rosterNames.set(row.smId, row.smName);
  }

  let applied = 0;

  for (const [appsNo, newSmId] of wanted) {
    const record = found.get(appsNo);
    if (!record) {
      unmatched += 1;
      continue;
    }
    if (record.smId === newSmId) continue;

    // sm_id and sm_name move together, always. The name comes from the roster
    // rather than from the file, because a typed name is how the two diverge.
    const newSmName = rosterNames.get(newSmId) ?? null;

    const [request] = await tx
      .insert(correctionRequest)
      .values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'MAPPING',
        fieldName: 'smId',
        fieldLabel: fieldLabel('smId'),
        originalValue: record.smId,
        proposedValue: newSmId,
        description: `Imported from the "${MAPPING_CHANGES_SHEET}" sheet of ${args.fileName}.`,
        submittedBy: args.actor.id,
        // The request's sm_id is the claimant's. Here the claim is on behalf of
        // the gaining rep, so it is the incoming SM_ID rather than the losing one.
        smId: newSmId,
        status: 'APPROVED',
        reviewedBy: args.actor.id,
        reviewedAt: new Date(),
        approverRemarks: 'Pre-approved: carried in from the source workbook.',
        appliedAt: new Date(),
      })
      .returning({ id: correctionRequest.id });

    const version = await applyRecordUpdate(tx, {
      recordId: record.id,
      changes: { smId: newSmId, smName: newSmName },
      changedFields: newSmName === record.smName ? ['smId'] : ['smId', 'smName'],
      batchId: args.batchId,
      actorId: args.actor.id,
      changeType: 'CORRECTION',
      correctionRequestId: request.id,
      markCorrected: true,
      note: `Reassigned from ${record.smId} to ${newSmId} by the "${MAPPING_CHANGES_SHEET}" sheet.`,
    });

    await tx
      .update(correctionRequest)
      .set({ appliedVersion: version })
      .where(eq(correctionRequest.id, request.id));

    applied += 1;
  }

  return { applied, unmatched };
}

/** Approved-correction field keys for one record, for the review screen. */
export async function protectedFieldsFor(recordId: string): Promise<string[]> {
  const rows = await db
    .select({ fieldName: correctionRequest.fieldName })
    .from(correctionRequest)
    .where(and(eq(correctionRequest.recordId, recordId), eq(correctionRequest.status, 'APPROVED')));
  return [...new Set(rows.map((r) => r.fieldName))];
}
