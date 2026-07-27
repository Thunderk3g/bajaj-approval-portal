import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import type { RequestAttachment, RequestEvent } from '@/lib/corrections/queries';
import { Badge, EmptyState, cx } from '@/components/ui';

/**
 * Read-only pieces of the request detail screen. Server components: none of
 * this is interactive, and marking it 'use client' would pull the page tree
 * into the browser bundle for the sake of a border colour.
 */

const EVENT_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted',
  RESUBMITTED: 'Resubmitted',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned for changes',
  WITHDRAWN: 'Withdrawn',
};

const EVENT_TONES: Record<string, string> = {
  SUBMITTED: 'bg-sky-500',
  RESUBMITTED: 'bg-sky-500',
  APPROVED: 'bg-emerald-500',
  REJECTED: 'bg-red-500',
  RETURNED: 'bg-amber-500',
  WITHDRAWN: 'bg-slate-400',
};

/**
 * The whole conversation on one timeline — spec sections 7 and 5.8.
 *
 * The status column only ever holds where a request is now. A returned request
 * that was resubmitted reads as PENDING again, and the approver's reason for
 * returning it would be gone if this were rendered from the row. It is rendered
 * from the event log instead, so every round trip survives.
 */
export function RequestTimeline({ events }: { events: RequestEvent[] }) {
  if (events.length === 0) {
    return <EmptyState title="No activity yet." />;
  }

  return (
    <ol className="space-y-0">
      {events.map((event, index) => (
        <li key={event.id} className="relative flex gap-3 pb-4 last:pb-0">
          <div className="flex flex-col items-center">
            <span
              className={cx('mt-1.5 size-2.5 shrink-0 rounded-full', EVENT_TONES[event.action] ?? 'bg-slate-400')}
              aria-hidden="true"
            />
            {index < events.length - 1 ? (
              <span className="w-px flex-1 bg-slate-200" aria-hidden="true" />
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-slate-900">
              {EVENT_LABELS[event.action] ?? event.action}
            </p>
            <p className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</p>
            {event.remarks ? (
              <p className="mt-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-sm text-slate-700">
                {event.remarks}
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Proof documents, served only through `/api/proofs/[id]`.
 *
 * The `src` is that route, never a path under `storage/` — there is no static
 * URL that reaches a proof, and every one of these requests is authorized and
 * audited on the way through (section 4.4).
 */
export function ProofList({ attachments }: { attachments: RequestAttachment[] }) {
  if (attachments.length === 0) {
    return <EmptyState title="No proof documents." />;
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {attachments.map((file) => (
        <li key={file.id} className="rounded border border-slate-200 p-2">
          <Link
            href={`/api/proofs/${file.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block"
          >
            {file.previewable ? (
              // A plain <img>, not next/image. The optimizer fetches and caches
              // the source on the server, which would put customer documents in
              // a cache that no longer knows who was allowed to see them — and
              // it would fetch them without the viewer's session, which the
              // proof route is right to refuse.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/proofs/${file.id}`}
                alt={file.originalName}
                className="h-32 w-full rounded border border-slate-100 bg-slate-50 object-contain"
              />
            ) : (
              <div className="flex h-32 items-center justify-center rounded border border-slate-100 bg-slate-50">
                <Badge tone="neutral">PDF</Badge>
              </div>
            )}

            <p className="mt-2 truncate text-sm font-medium text-slate-800" title={file.originalName}>
              {file.originalName}
            </p>
          </Link>

          <p className="text-xs text-slate-500">
            {formatBytes(file.sizeBytes)}
            <span className="px-1.5 text-slate-300" aria-hidden="true">
              |
            </span>
            {formatDateTime(file.uploadedAt)}
          </p>
          <p className="truncate font-mono text-[10px] text-slate-400" title={file.sha256}>
            sha256 {file.sha256.slice(0, 16)}…
          </p>
        </li>
      ))}
    </ul>
  );
}
