import { formatDateTime } from '@/lib/format';
import { apiPath } from '@/lib/nav';
import type { RequestAttachment, RequestEvent } from '@/lib/corrections/queries';
import { Badge, EmptyState, cx } from '@/components/ui';

/**
 * Read-only pieces of the request detail screen. Server components: none of
 * this is interactive, and marking it 'use client' would pull the page tree
 * into the browser bundle for the sake of a border colour.
 */

/**
 * Both maps must cover every value of `eventActionEnum`.
 *
 * An action that is missing falls back to its raw enum name and to grey, which
 * is what VERIFIED did until the verifier stage's own event became invisible on
 * the rep's timeline — the one entry telling them their request had cleared the
 * first gate rendered as the shoutier "VERIFIED" in the same colour as a
 * withdrawal.
 */
const EVENT_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted',
  RESUBMITTED: 'Resubmitted',
  // Phrased from the rep's side: what matters to them is not that a verifier
  // acted but that the request has moved on to the approver.
  VERIFIED: 'Verified — now with an approver',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned for changes',
  WITHDRAWN: 'Withdrawn',
};

const EVENT_TONES: Record<string, string> = {
  SUBMITTED: 'bg-sky-500',
  RESUBMITTED: 'bg-sky-500',
  // Not emerald: a verification is progress, not the outcome. Reusing the
  // approval colour would make a request that has merely cleared the first gate
  // read, at a glance down the timeline, as done.
  VERIFIED: 'bg-indigo-500',
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
            <p className="text-[13px] font-medium text-slate-900">
              {EVENT_LABELS[event.action] ?? event.action}
            </p>
            <p className="text-[11px] text-slate-500">{formatDateTime(event.createdAt)}</p>
            {event.remarks ? (
              <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[12px] leading-relaxed text-slate-700">
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
    // A row per document rather than a grid of tall tiles. This list sits in the
    // narrow column beside the request's progress, where a two-up grid of 128px
    // previews reduces each one to a thumbnail too small to read anyway — and
    // the filename is what a rep actually scans for.
    <ul className="space-y-2">
      {attachments.map((file) => (
        <li key={file.id} className="rounded-md border border-slate-200">
          {/* A plain anchor, not next/link. The response is a file, so there is
              no route for the client router to navigate to and nothing to
              prefetch — and it puts the proof link on the same footing as the
              approver's copy in request-view.tsx: one rule, apiPath everywhere,
              rather than one attribute the framework prefixes and one it does
              not. tests/lib/nav.test.ts enforces that as a source scan. */}
          <a
            href={apiPath(`/api/proofs/${file.id}`)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 p-2 hover:bg-slate-50"
          >
            {file.previewable ? (
              // A plain <img>, not next/image. The optimizer fetches and caches
              // the source on the server, which would put customer documents in
              // a cache that no longer knows who was allowed to see them — and
              // it would fetch them without the viewer's session, which the
              // proof route is right to refuse.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={apiPath(`/api/proofs/${file.id}`)}
                alt={file.originalName}
                className="size-11 shrink-0 rounded border border-slate-200 bg-slate-50 object-cover"
              />
            ) : (
              <span className="flex size-11 shrink-0 items-center justify-center rounded border border-slate-200 bg-slate-50">
                <Badge tone="neutral">PDF</Badge>
              </span>
            )}

            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-[12px] font-medium text-slate-900"
                title={file.originalName}
              >
                {file.originalName}
              </span>
              <span className="block text-[11px] text-slate-500">
                {formatBytes(file.sizeBytes)}
                <span className="px-1.5 text-slate-300" aria-hidden="true">
                  |
                </span>
                {formatDateTime(file.uploadedAt)}
              </span>
              <span
                className="block truncate font-mono text-[10px] text-slate-400"
                title={file.sha256}
              >
                sha256 {file.sha256.slice(0, 16)}…
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
