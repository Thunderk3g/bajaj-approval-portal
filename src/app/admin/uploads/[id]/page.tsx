import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { uploadBatch, user } from '@/db/schema';
import { requireRole } from '@/lib/auth/rbac';
import { formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/nav';
import { DEFAULT_DATE_FORMAT, type DateFormat } from '@/lib/import/dates';
import { suggestMapping } from '@/lib/import/mapping';
import type { ColumnMapping, SourceColumn, ValidationReport } from '@/lib/import/types';
import { toSourceColumns } from '@/lib/ingest/client';
import {
  isJobRunning,
  latestLeadsJob,
  latestParseJob,
  leadsResultOf,
  parseResultOf,
  type IngestJobRow,
} from '@/lib/ingest/queries';
import type { ParseJobResult } from '@/lib/ingest/types';
import {
  Alert,
  Card,
  DetailRow,
  LinkButton,
  PageHeader,
  StatusBadge,
  buttonClass,
} from '@/components/ui';
import { DeleteUploadButton } from '../_components/delete-upload-button';
import { ImportLeadsButton } from '../_components/leads-import';
import { MappingForm } from '../_components/mapping-form';
import { ParseProgress, ReparseButton } from '../_components/parse-status';
import { ReviewPanel } from '../_components/review-panel';
import { SheetPicker } from '../_components/sheet-picker';

/**
 * The review screen — 2026-07-28 ingestion spec sections 1 and 5.
 *
 * This page reads NO workbook. It used to call `listSheets()` and then
 * `readSheet()`, each a full `XLSX.read` of a 9.14 MB .xlsb, which is what made
 * `GET /admin/uploads/<id>` take 74.6 s against a 4.8 s upload and made the
 * whole flow look hung. Everything it renders now comes from two database rows:
 * the batch, and the most recent `ingest_job` for it.
 *
 * Which means every state below is a rendering of the job row, and the client
 * poller's only job is to notice when that row changes.
 */

export const metadata: Metadata = {
  title: 'Upload · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

/** Three values are enough to tell a mapped column from a mis-mapped one. */
const SAMPLE_COUNT = 3;

/**
 * Sample values per column, from the rows the parse job returned.
 *
 * `String()` on the raw value, deliberately: this is the same path the importer
 * takes, so a column that would arrive as 5.92E+09 shows that here rather than
 * looking correct until after the commit.
 */
function samplesFor(result: ParseJobResult, columns: SourceColumn[]): Record<string, string[]> {
  const samples: Record<string, string[]> = {};

  for (const column of columns) {
    const values: string[] = [];
    for (const row of result.sample_rows) {
      if (values.length >= SAMPLE_COUNT) break;
      const value = row[column.key];
      if (value === null || value === undefined || String(value).trim() === '') continue;
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

  // Read for any batch that is not aborted, a COMMITTED one included — its
  // `has_lead_dump` is what decides whether the Lead Dump card appears, and that
  // import is independent of the transaction commit.
  //
  // Every mapping-related use below is guarded by `isOpen` instead. A committed
  // batch is history: offering a mapping screen for a workbook whose records
  // already exist is the thing being avoided, not the read itself.
  const job = record.status === 'ABORTED' ? null : await latestParseJob(record.id);
  const parse = parseResultOf(job);

  const leadsJob = record.status === 'ABORTED' ? null : await latestLeadsJob(record.id);

  const columns = parse ? toSourceColumns(parse.columns) : [];
  const suggestion = columns.length > 0 ? suggestMapping(columns) : null;

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
            {/* A plain anchor, not LinkButton: the response is a file, so there
                is no route for the client router to reach. next/link would
                apply the base path for us here — which is precisely the
                inconsistency worth losing, since the sibling proof and export
                links cannot. apiPath everywhere, enforced by
                tests/lib/nav.test.ts. */}
            <a
              href={apiPath(`/api/uploads/${record.id}/original`)}
              className={buttonClass('secondary')}
            >
              Download original
            </a>
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

      <Card title="Source file">
        <dl>
          <DetailRow label="Stored as">
            <span className="font-mono text-xs">{record.storedPath}</span>
          </DetailRow>
          <DetailRow label="SHA-256">
            <span className="font-mono text-xs break-all">{record.fileHash}</span>
          </DetailRow>
          <DetailRow label="Sheet">{record.sheetName ?? parse?.chosen_sheet ?? 'not chosen yet'}</DetailRow>
          <DetailRow label="Header row">{record.headerRow}</DetailRow>
          <DetailRow label="Date format">{record.dateFormat}</DetailRow>
          {record.notes ? <DetailRow label="Notes">{record.notes}</DetailRow> : null}
          {record.committedAt ? (
            <DetailRow label="Committed">{formatDateTime(record.committedAt)}</DetailRow>
          ) : null}
        </dl>
      </Card>

      {isOpen ? (
        <ParseStep batchId={record.id} job={job} parse={parse} />
      ) : null}

      {isOpen && parse && parse.sheets.length > 0 ? (
        <Card
          title="1 · Sheet and parsing options"
          description="Parsing happens in the ingestion service, one sheet at a time. Choosing a different sheet queues a fresh read rather than blocking this page on one."
        >
          <SheetPicker
            batchId={record.id}
            sheets={parse.sheets.map((s) => s.name)}
            sheetName={record.sheetName ?? parse.chosen_sheet}
            headerRow={record.headerRow}
            dateFormat={(record.dateFormat as DateFormat) ?? DEFAULT_DATE_FORMAT}
          />
        </Card>
      ) : null}

      {isOpen && parse && suggestion ? (
        <Card
          title="2 · Column mapping"
          description={`${columns.length} columns found on row ${parse.header_row} of "${parse.chosen_sheet}", across ${parse.total_rows.toLocaleString('en-IN')} rows. Suggestions are matched on meaning, not spelling — override any of them.`}
        >
          <MappingForm
            batchId={record.id}
            columns={columns}
            samples={samplesFor(parse, columns)}
            suggestion={suggestion}
            current={record.columnMapping as ColumnMapping | null}
          />
        </Card>
      ) : null}

      {/* Outside the numbered steps on purpose. Leads are not part of the
          sheet → mapping → validate → commit sequence: they are a separate
          sheet with a separate destination, and numbering them would imply the
          commit depends on them. */}
      {parse?.has_lead_dump ? (
        <Card
          title="Lead Dump"
          description="Imported separately from the transaction rows and attributed by SM code. Leads are read-only: they carry no Apps_No, so they never join to a record, cannot be corrected, and do not enter the verifier queue."
        >
          <LeadsStep batchId={record.id} job={leadsJob} />
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

      {/* Last on the page and nowhere near the header, deliberately: this is the
          one control here that destroys something. A committed batch renders
          nothing — the component returns null rather than offering a button
          whose only outcome is a refusal. */}
      {record.status !== 'COMMITTED' ? (
        <Card
          title="Delete this upload"
          description="Removes the stored workbook, everything staged from it, and any leads it imported. Aborting instead keeps all three and only closes the batch."
        >
          <DeleteUploadButton
            batchId={record.id}
            fileName={record.originalFileName}
            redirectTo="/admin/uploads"
          />
        </Card>
      ) : null}
    </section>
  );
}

/**
 * Everything the Lead Dump import can be, rendered from its job row.
 *
 * Mirrors {@link ParseStep}, and the succeeded case is the one that differs: a
 * finished parse renders nothing because the mapping cards below it are the
 * success state, whereas a finished leads import has nowhere else to report
 * itself. Its numbers are stated here or not at all.
 */
function LeadsStep({ batchId, job }: { batchId: string; job: IngestJobRow | null }) {
  const result = leadsResultOf(job);

  if (!job) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          This workbook has a <span className="font-medium">Lead Dump</span> sheet that has not been
          imported. It streams — the sheet declares a 54,508 × 16,383 range that no reader can hold
          in memory — so this runs as a job and the page follows it.
        </p>
        <ImportLeadsButton batchId={batchId} label="Import leads" />
      </div>
    );
  }

  if (isJobRunning(job.status)) {
    return (
      <ParseProgress
        key={job.id}
        jobId={job.id}
        initial={{ status: job.status, stage: job.stage, done: job.done, total: job.total }}
      />
    );
  }

  if (job.status === 'FAILED') {
    return (
      <div className="space-y-3">
        <Alert tone="danger" title="The Lead Dump import failed">
          {job.error ?? 'The ingestion service reported no reason.'}
        </Alert>
        {/* Safe to retry unconditionally: every lead write is an upsert keyed on
            `lead_no`, so a re-run converges on the file rather than duplicating
            whatever the failed attempt had already committed. */}
        <ImportLeadsButton batchId={batchId} label="Try again" />
      </div>
    );
  }

  if (!result) {
    return (
      <div className="space-y-3">
        <Alert tone="danger" title="The import finished but returned nothing usable">
          The job succeeded without a row count. That is a mismatch between this app and the
          ingestion service, not a problem with the file.
        </Alert>
        <ImportLeadsButton batchId={batchId} label="Import again" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <LeadStat label="Rows read" value={result.total_rows} />
        <LeadStat label="Leads written" value={result.written} />
        <LeadStat label="Attributed to a rep" value={result.attributed} />
        <LeadStat label="Unassigned" value={result.unassigned} tone="warning" />
      </dl>

      <p className="text-xs text-slate-500">
        {result.distinct_sm_codes.toLocaleString('en-IN')} distinct SM codes.{' '}
        {result.unassigned > 0 ? (
          <>
            {result.unassigned.toLocaleString('en-IN')} leads carry{' '}
            <span className="font-mono">{result.unassigned_code}</span>, the sheet&rsquo;s own
            &ldquo;not given to anyone yet&rdquo; code — they are real leads with no owner, not
            errors.{' '}
          </>
        ) : null}
        {/* Stated even though it looks like bookkeeping: it is the entire
            difference between the rows read and the leads stored, and without it
            that gap reads as rows quietly lost. */}
        {result.duplicate_lead_nos > 0
          ? `${result.duplicate_lead_nos.toLocaleString('en-IN')} rows repeated a lead number already seen; the later row won. `
          : null}
        {result.skipped_no_lead_no > 0
          ? `${result.skipped_no_lead_no.toLocaleString('en-IN')} rows had no lead number and were skipped.`
          : null}
      </p>

      {result.orphan_count > 0 ? (
        <Alert tone="warning" title={`${result.orphan_count} SM code${result.orphan_count === 1 ? '' : 's'} not on the roster`}>
          <p>
            These codes own real leads but have no <span className="font-medium">Manpower</span> row,
            so nobody can sign in to see them. The leads are kept — the roster sheet is what is
            stale, not the data.
          </p>
          <p className="mt-1 font-mono text-xs break-all">
            {result.orphan_sm_codes.join(', ')}
            {result.orphan_count > result.orphan_sm_codes.length ? ' …' : null}
          </p>
        </Alert>
      ) : null}

      <ImportLeadsButton batchId={batchId} label="Import again" />
    </div>
  );
}

function LeadStat({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'warning';
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          tone === 'warning'
            ? 'mt-0.5 text-lg font-semibold tabular-nums text-amber-700'
            : 'mt-0.5 text-lg font-semibold tabular-nums text-slate-900'
        }
      >
        {value.toLocaleString('en-IN')}
      </dd>
    </div>
  );
}

/**
 * Everything the parse job can be, rendered from its row.
 *
 * A SUCCEEDED job renders nothing here — the sheet and mapping cards below it
 * are the success state, and a green "parse complete" banner above them would
 * be a second announcement of the same fact.
 */
function ParseStep({
  batchId,
  job,
  parse,
}: {
  batchId: string;
  job: IngestJobRow | null;
  parse: ParseJobResult | null;
}) {
  if (!job) {
    return (
      <Card title="Reading the workbook">
        <div className="space-y-3">
          <Alert tone="warning" title="No parse has been run for this upload">
            The file is stored and intact. Nothing has read it yet, which is what a batch created
            before the ingestion service existed looks like.
          </Alert>
          <ReparseButton batchId={batchId} label="Read this workbook" />
        </div>
      </Card>
    );
  }

  if (isJobRunning(job.status)) {
    return (
      <Card
        title="Reading the workbook"
        description="The upload is stored. This page updates itself as the parse progresses — there is nothing to wait on here."
      >
        {/* Keyed by job id so a re-parse gets a fresh component rather than one
            still holding the previous job's progress and its already-fired
            refresh guard. */}
        <ParseProgress
          key={job.id}
          jobId={job.id}
          initial={{
            status: job.status,
            stage: job.stage,
            done: job.done,
            total: job.total,
          }}
        />
      </Card>
    );
  }

  if (job.status === 'FAILED') {
    return (
      <Card title="Reading the workbook">
        <div className="space-y-3">
          {/* Spec section 7: the batch stays DRAFT, the file is retained, and the
              reader's own message is what is shown. It names a sheet or a
              structural problem, which is actionable; "the parse failed" is not. */}
          <Alert tone="danger" title="The workbook could not be read">
            {job.error ?? 'The ingestion service reported no reason.'}
          </Alert>
          <ReparseButton batchId={batchId} label="Try again" />
        </div>
      </Card>
    );
  }

  // SUCCEEDED, but the result is not the shape the mapping screen indexes into.
  // Rendering nothing would look like the page had simply stopped halfway, so
  // the dead end is stated and the only way out of it is offered.
  if (!parse) {
    return (
      <Card title="Reading the workbook">
        <div className="space-y-3">
          <Alert tone="danger" title="The parse finished but returned nothing usable">
            The job succeeded without a column list. That is a mismatch between this app and the
            ingestion service, not a problem with the file.
          </Alert>
          <ReparseButton batchId={batchId} label="Read it again" />
        </div>
      </Card>
    );
  }

  // No retry button here on purpose: reading the same row again produces the
  // same empty header. The fix is the header-row control in the card below, so
  // the message points at it rather than offering a button that cannot help.
  if (parse.columns.length === 0) {
    return (
      <Card title="Reading the workbook">
        <Alert tone="warning" title="That header row has no column names">
          Row {parse.header_row} of &ldquo;{parse.chosen_sheet}&rdquo; is empty. Some sheets carry
          totals above their headers — change the header row below and read it again.
        </Alert>
      </Card>
    );
  }

  return null;
}
