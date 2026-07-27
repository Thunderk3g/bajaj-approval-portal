import { readFile } from 'node:fs/promises';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatch, user } from '@/db/schema';
import { requireRole } from '@/lib/auth/rbac';
import { formatDateTime } from '@/lib/format';
import { DEFAULT_DATE_FORMAT, type DateFormat } from '@/lib/import/dates';
import { suggestMapping } from '@/lib/import/mapping';
import { listSheets, readSheet, suggestSheet } from '@/lib/import/parse';
import type { ColumnMapping, ParsedSheet, SheetInfo, ValidationReport } from '@/lib/import/types';
import { resolveStoredPath } from '@/lib/storage/paths';
import { Alert, Card, DetailRow, LinkButton, PageHeader, StatusBadge } from '@/components/ui';
import { MappingForm } from '../_components/mapping-form';
import { ReviewPanel } from '../_components/review-panel';
import { SheetPicker } from '../_components/sheet-picker';

export const metadata: Metadata = {
  title: 'Upload · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

/** Three values are enough to tell a mapped column from a mis-mapped one. */
const SAMPLE_COUNT = 3;
const SAMPLE_ROWS = 8;

function samplesFor(sheet: ParsedSheet): Record<string, string[]> {
  const samples: Record<string, string[]> = {};

  for (const column of sheet.columns) {
    const values: string[] = [];
    for (const row of sheet.rows) {
      if (values.length >= SAMPLE_COUNT) break;
      const value = row.cells[column.key];
      if (value === null || value === undefined || String(value).trim() === '') continue;
      // String() on the raw number, deliberately: this is the same path the
      // importer takes, so a column that would arrive as 5.92E+09 shows that
      // here rather than looking correct until after the commit.
      values.push(String(value));
    }
    samples[column.key] = values;
  }

  return samples;
}

export default async function UploadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reupload?: string }>;
}) {
  await requireRole('admin');

  const { id } = await params;
  const { reupload } = await searchParams;

  const [batch] = await db
    .select({
      batch: uploadBatch,
      uploadedByName: user.name,
    })
    .from(uploadBatch)
    .leftJoin(user, eq(uploadBatch.uploadedBy, user.id))
    .where(eq(uploadBatch.id, id));

  if (!batch) notFound();

  const record = batch.batch;
  const isOpen = record.status !== 'COMMITTED' && record.status !== 'ABORTED';
  const report = record.validationReport as ValidationReport | null;

  let sheets: SheetInfo[] = [];
  let sheet: ParsedSheet | null = null;
  let readError: string | null = null;

  if (isOpen) {
    try {
      const bytes = await readFile(resolveStoredPath(record.storedPath));
      sheets = listSheets(bytes);
      const chosen = record.sheetName ?? suggestSheet(sheets);
      if (chosen) {
        sheet = readSheet(bytes, {
          sheetName: chosen,
          headerRow: record.headerRow,
          maxRows: SAMPLE_ROWS,
        });
      }
    } catch (error) {
      readError = error instanceof Error ? error.message : 'The stored workbook could not be read.';
    }
  }

  const suggestion = sheet ? suggestMapping(sheet.columns) : null;

  return (
    <section className="space-y-6">
      <PageHeader
        title={record.originalFileName}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <StatusBadge status={record.status} />
            <span>Uploaded {formatDateTime(record.uploadedAt)} by {batch.uploadedByName ?? '—'}</span>
          </span>
        }
        actions={
          <>
            <LinkButton href={`/api/uploads/${record.id}/original`} prefetch={false}>
              Download original
            </LinkButton>
            <LinkButton href="/admin/uploads">Back to uploads</LinkButton>
          </>
        }
      />

      {reupload ? (
        <Alert tone="warning" title="This file has been uploaded before">
          A previous batch has the identical SHA-256 hash. Re-importing a stale export is how an
          approved correction gets reverted — fields carrying one are protected, and any
          disagreement will appear as a conflict on the review step below.
        </Alert>
      ) : null}

      {readError ? <Alert tone="danger">{readError}</Alert> : null}

      <Card title="Source file">
        <dl>
          <DetailRow label="Stored as">
            <span className="font-mono text-xs">{record.storedPath}</span>
          </DetailRow>
          <DetailRow label="SHA-256">
            <span className="font-mono text-xs break-all">{record.fileHash}</span>
          </DetailRow>
          <DetailRow label="Sheet">{record.sheetName ?? 'not chosen yet'}</DetailRow>
          <DetailRow label="Header row">{record.headerRow}</DetailRow>
          <DetailRow label="Date format">{record.dateFormat}</DetailRow>
          {record.notes ? <DetailRow label="Notes">{record.notes}</DetailRow> : null}
          {record.committedAt ? (
            <DetailRow label="Committed">{formatDateTime(record.committedAt)}</DetailRow>
          ) : null}
        </dl>
      </Card>

      {isOpen && sheets.length > 0 ? (
        <Card
          title="1 · Sheet and parsing options"
          description="Parsing is limited to the sheet you pick. Reading all ten sheets of the source workbook takes 37 seconds; reading the two that matter takes under three."
        >
          <SheetPicker
            batchId={record.id}
            sheets={sheets}
            sheetName={record.sheetName ?? suggestSheet(sheets) ?? sheets[0]!.name}
            headerRow={record.headerRow}
            dateFormat={(record.dateFormat as DateFormat) ?? DEFAULT_DATE_FORMAT}
          />
        </Card>
      ) : null}

      {isOpen && sheet && suggestion ? (
        <Card
          title="2 · Column mapping"
          description={`${sheet.columns.length} columns found on row ${sheet.headerRow} of "${sheet.sheetName}". Suggestions are matched on meaning, not spelling — override any of them.`}
        >
          <MappingForm
            batchId={record.id}
            columns={sheet.columns}
            samples={samplesFor(sheet)}
            suggestion={suggestion}
            current={record.columnMapping as ColumnMapping | null}
          />
        </Card>
      ) : null}

      {report ? (
        <Card
          title={isOpen ? '3 · Validation report' : 'Validation report'}
          description={`Validated against ${report.sheetName} using ${report.dateFormat}.`}
        >
          <ReviewPanel
            batchId={record.id}
            report={report}
            committable={record.status === 'VALIDATED'}
          />
        </Card>
      ) : null}

      {record.status === 'COMMITTED' ? (
        <Alert tone="success" title="Committed">
          {record.validRows.toLocaleString('en-IN')} rows were written to the master records. The
          stored workbook above is unchanged and remains the original of record.
        </Alert>
      ) : null}
    </section>
  );
}
