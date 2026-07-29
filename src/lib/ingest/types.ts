/**
 * The wire shapes of `reconciliation-ingest`, with no runtime dependencies.
 *
 * Split out of `client.ts` on purpose. The client reads `INGEST_TOKEN` from
 * `@/lib/env`, and the progress component is a `'use client'` file that needs to
 * name a job status. `import type` is erased, so importing the client for a type
 * alone is safe today — but one edit dropping the `type` keyword would put the
 * shared secret in the browser bundle, and nothing would fail loudly. A module
 * that holds no secret to leak removes that possibility rather than documenting
 * it.
 *
 * Field names are the service's own snake_case, deliberately. This is the wire
 * contract of another service in another language; renaming its fields here
 * would mean two spellings for the same thing and a translation layer to keep
 * correct, and the first field it adds would find the two silently disagreeing.
 */

export type IngestJobKind = 'PARSE' | 'LEADS' | 'PROOF';
export type IngestJobStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

/** `GET /jobs/{id}`. */
export type IngestJob = {
  job_id: string;
  kind: IngestJobKind;
  status: IngestJobStatus;
  /** Human-readable phase, e.g. "streaming Lead Dump". Shown verbatim. */
  stage: string | null;
  done: number;
  /** Null while genuinely unknown — a made-up denominator is a bar that lies. */
  total: number | null;
  result: unknown;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
};

/** What a SUCCEEDED PARSE job carries in `result`. */
export type ParseJobResult = {
  sheets: Array<{ name: string }>;
  chosen_sheet: string;
  header_row: number;
  columns: string[];
  sample_rows: Array<Record<string, unknown>>;
  total_rows: number;
  has_lead_dump: boolean;
};

/**
 * What a SUCCEEDED LEADS job carries in `result`.
 *
 * `total_rows` counts rows the sheet yielded; `written` counts leads actually
 * upserted. They differ by the rows with no lead number, and reporting both is
 * the point — a single number would hide a mapping change that silently started
 * dropping a tenth of the file.
 */
export type LeadsJobResult = {
  total_rows: number;
  written: number;
  attributed: number;
  /** Leads carrying the sheet's own "not given to anyone yet" sentinel. */
  unassigned: number;
  unassigned_code: string;
  skipped_no_lead_no: number;
  /**
   * Rows whose lead number had already appeared earlier in the sheet.
   *
   * The real file carries 135 of them across 54,507 rows, and the last
   * occurrence wins. Reported because it is the whole difference between
   * `total_rows` and the number of leads in the table — without it, 54,507 rows
   * producing 54,372 leads reads as 135 rows silently lost.
   */
  duplicate_lead_nos: number;
  distinct_sm_codes: number;
  /** Codes owning real leads but absent from the roster. Capped at 100. */
  orphan_sm_codes: string[];
  orphan_count: number;
};

/** The answer to `POST /jobs/parse` and `POST /jobs/leads`. */
export type StartedJob = { job_id: string; status: IngestJobStatus };
