import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { ingestJob } from '@/db/schema';
import type { IngestJobStatus, LeadsJobResult, ParseJobResult } from './types';

/**
 * Reading `ingest_job` from the Next.js side.
 *
 * The rows are written by the Python service, never by this app — spec section
 * 4. Reading them straight out of the shared database rather than polling
 * `GET /jobs/{id}` server-side is what lets the review page render in one round
 * trip: the page already has a database connection, and a page that had to wait
 * on an HTTP call to another service before it could paint would have swapped a
 * 74-second parse for a smaller version of the same problem.
 */

export type IngestJobRow = typeof ingestJob.$inferSelect;

/**
 * The most recent PARSE job for a batch, or null when none has ever run.
 *
 * Most recent rather than "the succeeded one": a re-parse after a sheet change
 * supersedes its predecessor, and showing the older successful result would
 * offer the admin columns from a sheet they have already moved off.
 */
export async function latestParseJob(batchId: string): Promise<IngestJobRow | null> {
  const [row] = await db
    .select()
    .from(ingestJob)
    .where(and(eq(ingestJob.batchId, batchId), eq(ingestJob.kind, 'PARSE')))
    .orderBy(desc(ingestJob.createdAt))
    .limit(1);

  return row ?? null;
}

/**
 * The most recent LEADS job for a batch.
 *
 * Separate from {@link latestParseJob} rather than a `kind` parameter with a
 * shared caller, because the two are read for different questions and a caller
 * that got the wrong kind back would render a Lead Dump import's progress as a
 * column list. The `kind` filter is the whole safety here, so it is spelled out
 * in each.
 */
export async function latestLeadsJob(batchId: string): Promise<IngestJobRow | null> {
  const [row] = await db
    .select()
    .from(ingestJob)
    .where(and(eq(ingestJob.batchId, batchId), eq(ingestJob.kind, 'LEADS')))
    .orderBy(desc(ingestJob.createdAt))
    .limit(1);

  return row ?? null;
}

export function isJobRunning(status: IngestJobStatus | null | undefined): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

/**
 * The leads result, but only from a job that actually succeeded.
 *
 * Same narrow shape check as {@link parseResultOf}, and for the same reason: a
 * FAILED job can carry a partially written result, and a summary rendered from
 * one would report a row count for an import that did not finish.
 */
export function leadsResultOf(job: IngestJobRow | null): LeadsJobResult | null {
  if (!job || job.status !== 'SUCCEEDED' || !job.result) return null;

  const result = job.result as Partial<LeadsJobResult>;
  if (typeof result.written !== 'number' || typeof result.total_rows !== 'number') return null;

  return result as LeadsJobResult;
}

/**
 * The parse result, but only from a job that actually succeeded.
 *
 * `result` is jsonb and therefore `unknown` to Drizzle. The shape check below is
 * deliberately narrow — columns and sample rows — because those two are what
 * every caller goes on to index into. A FAILED job can carry a partially written
 * result, and rendering the mapping screen from one would offer the admin a
 * column list the parse never finished building.
 */
export function parseResultOf(job: IngestJobRow | null): ParseJobResult | null {
  if (!job || job.status !== 'SUCCEEDED' || !job.result) return null;

  const result = job.result as Partial<ParseJobResult>;
  if (!Array.isArray(result.columns) || !Array.isArray(result.sample_rows)) return null;

  return result as ParseJobResult;
}
