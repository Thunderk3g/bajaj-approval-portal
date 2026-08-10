'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { reparseBatchAction } from '@/lib/import/actions';
import { apiPath } from '@/lib/nav';
import type { IngestJobStatus } from '@/lib/ingest/types';
import { Alert, Button, Spinner } from '@/components/ui';

/**
 * The live half of the review page — 2026-07-28 ingestion spec section 5.
 *
 * The page itself renders from the `ingest_job` row and is done in one round
 * trip; this component exists only to notice when that row changes. It polls
 * `/api/ingest/jobs/[jobId]`, a Route Handler, rather than the service directly:
 * the service authenticates with `INGEST_TOKEN` and putting that in the browser
 * bundle would publish it.
 *
 * `progress` is `{stage, done, total}` for the reason the spec gives — so the UI
 * can say "reading Login Data, 1 of 3" rather than spinning. `total` is null
 * whenever the service genuinely does not know it, and the bar is replaced by a
 * plain count in that case; a made-up denominator is a progress bar that lies.
 */

/**
 * A parse of the real 9.14 MB workbook finishes in about a third of a second, so
 * this is less "poll until done" than "notice within one frame of done". Slower
 * would leave the admin looking at a finished job; faster would be a request per
 * 100 ms for work that is already over.
 */
const POLL_MS = 1_500;

/**
 * The subset of `GET /jobs/{id}` this component renders.
 *
 * `error` is deliberately absent: a FAILED job triggers a refresh and the server
 * renders the reader's message. Holding a second copy of it here would be a
 * second place for the failure text to be phrased.
 */
type JobSnapshot = {
  status: IngestJobStatus;
  stage: string | null;
  done: number;
  total: number | null;
};

function isRunning(status: IngestJobStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING';
}

export function ParseProgress({ jobId, initial }: { jobId: string; initial: JobSnapshot }) {
  const router = useRouter();
  const [job, setJob] = useState<JobSnapshot>(initial);
  const [unreachable, setUnreachable] = useState(false);
  const [lost, setLost] = useState(false);

  // The refresh must fire exactly once per terminal job. Without this guard the
  // poll that observed SUCCEEDED would keep firing refreshes until React got
  // round to unmounting this component, and each one re-renders the whole page.
  const refreshed = useRef(false);

  const poll = useCallback(
    async (signal: AbortSignal) => {
      try {
        const response = await fetch(apiPath(`/api/ingest/jobs/${jobId}`), {
          signal,
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });

        if (response.status === 503) {
          // The service is down but the job row is not lost — it is in Postgres.
          // Polling continues so the page recovers on its own when the service
          // comes back, rather than needing a manual reload.
          setUnreachable(true);
          return;
        }
        if (!response.ok) {
          // 404 here is both "no such job" and "this session is no longer an
          // admin" — the route refuses to distinguish them, on the same
          // reasoning as spec section 8. Neither recovers by polling again, and
          // a spinner that never resolves is worse than saying so.
          setUnreachable(false);
          setLost(true);
          return;
        }

        const next = (await response.json()) as JobSnapshot;
        setUnreachable(false);
        setJob(next);

        if (!isRunning(next.status) && !refreshed.current) {
          refreshed.current = true;
          // Both outcomes refresh: SUCCEEDED brings in the mapping step, FAILED
          // brings in the server-rendered error and its retry button. Neither is
          // reconstructed here, so the page stays the one description of state.
          router.refresh();
        }
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return;
        setUnreachable(true);
      }
    },
    [jobId, router],
  );

  useEffect(() => {
    if (lost || !isRunning(job.status)) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void poll(controller.signal), POLL_MS);
    };
    const stop = () => {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    };

    // A backgrounded tab polling every 1.5 s for a job nobody is watching is
    // pure load; the immediate fetch on return is what makes suspending it
    // invisible to the admin who comes back to the tab.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void poll(controller.signal);
        start();
      } else {
        stop();
      }
    };

    void poll(controller.signal);
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      controller.abort();
    };
  }, [job.status, lost, poll]);

  const percent =
    job.total && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Spinner className="text-slate-500" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-slate-900">
            {job.stage ?? (job.status === 'QUEUED' ? 'Waiting for a worker' : 'Reading the workbook')}
          </p>
          <p className="text-[12px] text-slate-500 tabular-nums">
            {percent !== null
              ? `${job.done.toLocaleString('en-IN')} of ${job.total!.toLocaleString('en-IN')}`
              : job.done > 0
                ? `${job.done.toLocaleString('en-IN')} rows so far`
                : 'Starting'}
          </p>
        </div>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-label="Workbook parse progress"
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={
            percent !== null
              ? 'h-full rounded-full bg-slate-800 transition-[width] duration-300'
              : 'h-full w-1/3 animate-pulse rounded-full bg-slate-400'
          }
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>

      {unreachable ? (
        <Alert tone="warning" title="The ingestion service is not answering">
          The job itself is recorded in the database and is not lost. This page keeps checking and
          will pick up where it left off once the service is back.
        </Alert>
      ) : null}

      {lost ? (
        <Alert tone="danger" title="This job can no longer be read">
          Either it no longer exists or this session is no longer signed in as an admin. Reload the
          page to find out which.
        </Alert>
      ) : null}
    </div>
  );
}

/**
 * Restarts the parse for a batch whose job failed or never started.
 *
 * Spec section 7 keeps the batch DRAFT and the stored file on disk after a
 * failure, which is only useful if there is a way back — otherwise a service
 * that was down for a minute would cost a 9 MB re-upload.
 */
export function ReparseButton({ batchId, label }: { batchId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);
    const result = await reparseBatchAction({ batchId });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <Button type="button" onClick={() => void run()} disabled={pending}>
        {pending ? 'Starting…' : label}
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
