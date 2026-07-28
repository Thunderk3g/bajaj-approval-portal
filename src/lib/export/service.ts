import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { db } from '@/db/client';
import { excelExport } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import type { SessionUser } from '@/lib/auth/rbac';
import { notify } from '@/lib/notifications/service';
import { allocateStoragePath, ensureStorageDirs, EXPORTS_DIR } from '@/lib/storage/paths';
import { exportFileName, exportWorkbookBuffer } from './build';
import {
  batchLabel,
  fetchAppliedCorrections,
  fetchExportRecords,
  nextExportVersion,
  periodLabelsFor,
} from './queries';
import { describeFilters, type ExportFilters } from './schemas';

export type GeneratedExport = {
  id: string;
  fileName: string;
  rowCount: number;
  correctionCount: number;
  sha256: string;
};

type Actor = Pick<SessionUser, 'id' | 'email' | 'role' | 'name'>;

/**
 * Generates one export — spec section 8.
 *
 * The actor is a parameter rather than something this function fetches, so the
 * authorization check stays where the hard rule puts it: in the Server Action
 * and the Route Handler, each calling `requireRole` itself. It also makes the
 * whole pipeline testable without a session.
 */
export async function runExport(
  actor: Actor,
  filters: ExportFilters,
  now: Date = new Date(),
): Promise<GeneratedExport> {
  await ensureStorageDirs();

  const records = await fetchExportRecords(filters);
  const corrections = await fetchAppliedCorrections(records.map((r) => r.id));
  const periodLabels = await periodLabelsFor(records);

  const version = await nextExportVersion();
  const fileName = exportFileName(now, version);

  const buffer = await exportWorkbookBuffer({
    records,
    corrections,
    periodLabels,
    meta: {
      fileName,
      generatedAt: now,
      generatedByName: actor.name,
      generatedByEmail: actor.email,
      filters,
      batchLabel: await batchLabel(filters.batchId),
    },
  });

  const sha256 = createHash('sha256').update(buffer).digest('hex');

  // The file lands before the row that describes it. The other order would let
  // a crash between the two leave an `excel_export` row whose download link
  // 404s — a broken promise in the UI. A file with no row is invisible instead:
  // wasted disk, not a wrong answer.
  const { absolutePath, relativePath } = await allocateStoragePath(EXPORTS_DIR, 'xlsx', now);
  await writeFile(absolutePath, buffer);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(excelExport)
      .values({
        requestedBy: actor.id,
        fileName,
        storedPath: relativePath,
        sha256,
        rowCount: records.length,
        correctionCount: corrections.length,
        filters,
      })
      .returning({ id: excelExport.id });

    await writeAudit(
      {
        actor,
        action: 'EXPORT_GENERATE',
        entityType: 'excel_export',
        entityId: row.id,
        after: { fileName, rowCount: records.length, correctionCount: corrections.length, sha256 },
        metadata: { filters },
      },
      tx,
    );

    await notify(
      {
        userId: actor.id,
        type: 'EXPORT_READY',
        title: `Export ready — ${fileName}`,
        body: `${records.length} record${records.length === 1 ? '' : 's'}, ${corrections.length} applied correction${corrections.length === 1 ? '' : 's'}. Filters: ${describeFilters(filters).join('; ')}.`,
        link: '/admin/exports',
      },
      tx,
    );

    return {
      id: row.id,
      fileName,
      rowCount: records.length,
      correctionCount: corrections.length,
      sha256,
    };
  });
}
