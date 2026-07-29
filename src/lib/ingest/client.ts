import { env } from '@/lib/env';
import type { SourceColumn } from '@/lib/import/types';
import type { IngestJob, StartedJob } from './types';

/**
 * The only way this application talks to `reconciliation-ingest` — 2026-07-28
 * ingestion spec sections 4, 5 and 8.
 *
 * SERVER-SIDE ONLY. Every call carries `INGEST_TOKEN`, and a module that a
 * client component could import is a module whose secret ends up in the browser
 * bundle. Nothing here may be reached from a `'use client'` file; the job poll
 * goes through `/api/ingest/jobs/[jobId]` for exactly that reason.
 *
 * The whole point of this boundary is that it fails LOUDLY. A raw `fetch`
 * rejection crossing into a Server Action reaches the admin as Next's redacted
 * "an error occurred" in production, which is indistinguishable from a bug in
 * the upload itself. Everything below is translated into one of two domain
 * errors so the caller can say which of "the service is not there" and "the
 * service said no" happened.
 */

// Re-exported so a server caller needs one import, while `./types` stays
// importable on its own by anything that must not pull the token in with it.
export type {
  IngestJob,
  IngestJobKind,
  IngestJobStatus,
  ParseJobResult,
  StartedJob,
} from './types';

export class IngestError extends Error {}

/**
 * The service could not be reached at all: connection refused, DNS, or a
 * request that outlived {@link REQUEST_TIMEOUT_MS}.
 *
 * Spec section 7 makes this a refusal rather than a degraded path — a workbook
 * accepted and then silently unparsed is worse than one that was never accepted.
 */
export class IngestUnavailableError extends IngestError {
  constructor(action: string, options?: { cause?: unknown }) {
    super(
      `The ingestion service could not be reached while ${action}. ` +
        `Uploads need it to read the workbook, so nothing was accepted. ` +
        `Check that reconciliation-ingest is running at ${env.INGEST_URL}.`,
      options,
    );
    this.name = 'IngestUnavailableError';
  }
}

/** The service answered and refused. `status` 404 also means a rejected token. */
export class IngestResponseError extends IngestError {
  constructor(
    action: string,
    readonly status: number,
  ) {
    super(
      status === 404
        ? `The ingestion service refused the request while ${action}. ` +
          `It returns 404 for an unknown job and for a wrong X-Ingest-Token alike, ` +
          `so check INGEST_TOKEN matches the service's.`
        : `The ingestion service failed with HTTP ${status} while ${action}.`,
    );
    this.name = 'IngestResponseError';
  }
}

/**
 * Ceiling on a single call.
 *
 * Node's `fetch` has no default timeout, so a service that accepts the
 * connection and then never answers would hold a Server Action open until the
 * browser gave up — which is the 74-second hang this whole change exists to
 * remove, reintroduced through the fix for it. Every endpoint called here is an
 * enqueue or a single-row read, so seconds is already generous; the long work
 * happens in the job, not in the request that starts it.
 */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Sample rows a parse job returns for the review page.
 *
 * Three values per column are what tell a mapped column from a mis-mapped one;
 * eight rows is enough to survive a handful of blanks in the first few. It is
 * set here rather than left to the service's own default so the number the
 * mapping screen depends on lives next to the screen that depends on it.
 */
export const DEFAULT_SAMPLE_ROWS = 8;

export type StartParseInput = {
  batchId: string;
  storedPath: string;
  sheetName?: string | null;
  headerRow?: number;
  sampleRows?: number;
  requestedBy?: string | null;
};

export type StartLeadsInput = {
  batchId: string;
  storedPath: string;
  requestedBy?: string | null;
};

function endpoint(path: string): string {
  // Concatenated rather than resolved through `new URL(path, base)`: URL
  // resolution against a base carrying a path segment discards that segment, so
  // an INGEST_URL of `http://gateway/ingest` would silently call `/jobs/parse`
  // at the root and get somebody else's 404.
  return `${env.INGEST_URL.replace(/\/+$/, '')}${path}`;
}

async function call<T>(path: string, action: string, init?: RequestInit): Promise<T> {
  let response: Response;

  try {
    response = await fetch(endpoint(path), {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'X-Ingest-Token': env.INGEST_TOKEN,
        ...init?.headers,
      },
      // A job's status changes underneath us by design; a cached one would show
      // QUEUED forever while the parse finished behind it.
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new IngestUnavailableError(action, { cause });
  }

  if (!response.ok) throw new IngestResponseError(action, response.status);

  try {
    return (await response.json()) as T;
  } catch (cause) {
    // A 200 that is not JSON means something other than the service answered —
    // a proxy error page, most likely. Treating it as unreachable is honest:
    // whatever replied, it was not reconciliation-ingest.
    throw new IngestUnavailableError(action, { cause });
  }
}

/**
 * Enqueues the read the review page needs: sheet names, columns and a few real
 * rows of the chosen sheet.
 *
 * The batch row must already exist — `ingest_job.batch_id` is a foreign key to
 * it, and the service inserts the job row itself.
 */
export function startParseJob(input: StartParseInput): Promise<StartedJob> {
  return call<StartedJob>('/jobs/parse', 'starting the workbook parse', {
    method: 'POST',
    body: JSON.stringify({
      batch_id: input.batchId,
      stored_path: input.storedPath,
      sheet_name: input.sheetName ?? null,
      header_row: input.headerRow ?? 1,
      sample_rows: input.sampleRows ?? DEFAULT_SAMPLE_ROWS,
      requested_by: input.requestedBy ?? null,
    }),
  });
}

export function startLeadsJob(input: StartLeadsInput): Promise<StartedJob> {
  return call<StartedJob>('/jobs/leads', 'starting the Lead Dump import', {
    method: 'POST',
    body: JSON.stringify({
      batch_id: input.batchId,
      stored_path: input.storedPath,
      requested_by: input.requestedBy ?? null,
    }),
  });
}

export function getIngestJob(jobId: string): Promise<IngestJob> {
  // encodeURIComponent, not interpolation: the id reaches this from a URL
  // segment, and an unencoded `../proofs/inspect` would address a different
  // endpoint of the service entirely with a valid token attached.
  return call<IngestJob>(`/jobs/${encodeURIComponent(jobId)}`, 'reading the job status');
}

/**
 * Turns the service's flat column names into the shape the mapping screen and
 * `validateMapping` already speak.
 *
 * The service's `build_columns` and this app's `buildColumns` deliberately emit
 * the SAME strings — `Location (1)` for a duplicated header, `(column 14)` for a
 * blank one — so a column maps to the same key whichever path read the file.
 * That agreement is what makes this reconstruction safe rather than a guess.
 *
 * The occurrence suffix is stripped back off for `header`, because that is the
 * text the suggestion scorer matches on: `Location (2)` normalises to
 * `location2`, matches no alias, and the second of a duplicated pair would lose
 * every suggestion the first one gets.
 */
export function toSourceColumns(names: string[]): SourceColumn[] {
  const blankPattern = /^\(column \d+\)$/;
  const occurrencePattern = /^(.*) \((\d+)\)$/;

  return names.map((key, index) => {
    if (blankPattern.test(key)) {
      return { index, header: '', key, blank: true, duplicate: false };
    }
    const repeated = occurrencePattern.exec(key);
    return {
      index,
      header: repeated ? repeated[1]! : key,
      key,
      blank: false,
      duplicate: Boolean(repeated),
    };
  });
}
