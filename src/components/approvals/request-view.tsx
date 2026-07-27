import Link from 'next/link';
import { Alert, Badge, Card, DetailRow, EmptyState, StatusBadge, cx } from '@/components/ui';
import { formatDate, formatDateTime, formatMoney, orDash } from '@/lib/format';
import { CATEGORY_LABELS, type CorrectionCategory } from '@/lib/approvals/schemas';
import type { MappingContext, RequestDetail } from '@/lib/approvals/queries';

/**
 * The read-only half of the decision screen.
 *
 * Server Components throughout: none of this is interactive, and rendering it on
 * the server keeps the full record — premium figures included — out of the
 * client bundle.
 */

export function CategoryBadge({ category }: { category: string }) {
  const tone =
    category === 'MAPPING' ? 'warning' : category === 'AUTOPAY' ? 'info' : ('neutral' as const);
  return <Badge tone={tone}>{CATEGORY_LABELS[category as CorrectionCategory] ?? category}</Badge>;
}

/**
 * Original beside proposed, with the record's live value as the tiebreaker.
 *
 * `original_value` is a snapshot taken when the request was submitted. If the
 * record has moved since — a re-import, an admin edit, another approved
 * correction — approving still overwrites whatever is there now, so the drift is
 * surfaced rather than hidden behind a stale "from" column.
 */
export function Comparison({
  fieldLabel,
  submittedOriginal,
  liveValue,
  proposed,
  description,
}: {
  fieldLabel: string;
  submittedOriginal: string | null;
  liveValue: string | null;
  proposed: string;
  description: string | null;
}) {
  const drifted = (submittedOriginal ?? '') !== (liveValue ?? '');

  return (
    <Card title={`Proposed change — ${fieldLabel}`}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Current value on the record
          </p>
          <p className="mt-1 break-words font-mono text-sm text-slate-900">{orDash(liveValue)}</p>
          {drifted ? (
            <p className="mt-1.5 text-xs text-amber-700">
              At submission this read {orDash(submittedOriginal)}. The record has changed since.
            </p>
          ) : null}
        </div>

        <div className="rounded border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">
            Proposed value
          </p>
          <p className="mt-1 break-words font-mono text-sm text-emerald-900">{orDash(proposed)}</p>
        </div>
      </div>

      {description ? (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Submitter&rsquo;s note
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{description}</p>
        </div>
      ) : null}
    </Card>
  );
}

export function RecordContext({ record }: { record: RequestDetail['record'] }) {
  return (
    <Card title="Record context" description={`Version ${record.currentVersion}`}>
      <dl>
        <DetailRow label="Application no.">
          <span className="font-mono">{record.appsNo}</span>
        </DetailRow>
        <DetailRow label="Policy no.">
          <span className="font-mono">{orDash(record.policyNo)}</span>
        </DetailRow>
        <DetailRow label="Client">{orDash(record.clientName)}</DetailRow>
        <DetailRow label="Status">
          <StatusBadge status={record.status} />
          {record.status2 ? <span className="ml-2 text-slate-600">{record.status2}</span> : null}
        </DetailRow>
        <DetailRow label="Product">
          {orDash(record.productName)}
          {record.productType ? (
            <span className="text-slate-500"> · {record.productType}</span>
          ) : null}
        </DetailRow>
        <DetailRow label="Issued date">{formatDate(record.issuedDate)}</DetailRow>
        <DetailRow label="Login date">{formatDate(record.loginDate)}</DetailRow>
        <DetailRow label="FP / ANP">
          <span className="tabular-nums">
            {formatMoney(record.fp)} / {formatMoney(record.anp)}
          </span>
        </DetailRow>
        <DetailRow label="AutoPay">{orDash(record.autopay)}</DetailRow>
        <DetailRow label="Owner">
          <span className="font-mono">{record.smId}</span>
          <span className="text-slate-600"> · {orDash(record.smName)}</span>
        </DetailRow>
        <DetailRow label="TL / CCM">
          {orDash(record.tlName)} / {orDash(record.ccmName)}
        </DetailRow>
        <DetailRow label="Location">{orDash(record.location)}</DetailRow>
      </dl>
    </Card>
  );
}

/**
 * Both reps side by side — spec 7.2.
 *
 * The approver decides alone; the losing rep is notified, not consulted. Showing
 * both identities is what makes that decision an informed one rather than a
 * rubber stamp on an SM_ID string.
 */
export function MappingPanel({ mapping }: { mapping: MappingContext }) {
  const Party = ({
    heading,
    tone,
    smId,
    recordName,
    rosterName,
    inRoster,
    account,
  }: {
    heading: string;
    tone: 'current' | 'claim';
    smId: string;
    recordName?: string | null;
    rosterName: string | null;
    inRoster: boolean;
    account: { name: string; email: string } | null;
  }) => (
    <div
      className={cx(
        'rounded border p-3',
        tone === 'claim' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50',
      )}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{heading}</p>
      <p className="mt-1 font-mono text-sm font-semibold text-slate-900">{smId}</p>
      {recordName !== undefined ? (
        <p className="mt-1 text-sm text-slate-800">On the record: {orDash(recordName)}</p>
      ) : null}
      <p className="mt-0.5 text-sm text-slate-800">
        Roster: {inRoster ? orDash(rosterName) : <span className="text-amber-700">not listed</span>}
      </p>
      <p className="mt-0.5 text-xs text-slate-600">
        Portal account: {account ? `${account.name} (${account.email})` : 'none'}
      </p>
    </div>
  );

  return (
    <Card
      title="Mapping claim"
      description="Approving moves the sale. Both reps are notified; the losing rep is not asked to agree."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Party
          heading="Current owner (loses the sale)"
          tone="current"
          smId={mapping.currentSmId}
          recordName={mapping.currentSmName}
          rosterName={mapping.currentRosterName}
          inRoster={mapping.currentInRoster}
          account={mapping.currentAccount}
        />
        <Party
          heading="Claimant (gains the sale)"
          tone="claim"
          smId={mapping.claimSmId}
          rosterName={mapping.claimRosterName}
          inRoster={mapping.claimInRoster}
          account={mapping.claimAccount}
        />
      </div>

      {!mapping.claimInRoster ? (
        <div className="mt-3">
          <Alert tone="warning" title="The claimant is not in the Manpower roster">
            Approving will move the record and clear <span className="font-mono">SM_Name</span>{' '}
            rather than write a name that may be wrong. Ask an admin to add the roster entry first
            if the name matters.
          </Alert>
        </div>
      ) : null}
    </Card>
  );
}

export function ProofList({ attachments }: { attachments: RequestDetail['attachments'] }) {
  if (attachments.length === 0) {
    return (
      <Card title="Proof">
        <Alert tone="warning">
          This request has no attachment. At least one is required at submission, so its absence
          means the request predates that rule or the file was removed — treat the claim as
          unevidenced.
        </Alert>
      </Card>
    );
  }

  return (
    <Card title={`Proof (${attachments.length})`}>
      <ul className="space-y-4">
        {attachments.map((a) => (
          <li key={a.id} className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <a
                href={`/api/proofs/${a.id}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
              >
                {a.originalName}
              </a>
              <span className="text-xs text-slate-500">
                {a.mimeType} · {Math.max(1, Math.round(a.sizeBytes / 1024))} KB ·{' '}
                {formatDateTime(a.uploadedAt)}
              </span>
            </div>

            {a.mimeType.startsWith('image/') ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/proofs/${a.id}`}
                alt={a.originalName}
                className="max-h-96 w-auto max-w-full rounded border border-slate-200"
              />
            ) : (
              <p className="text-xs text-slate-500">
                Opens in a new tab — PDFs are not inlined so the browser&rsquo;s own viewer handles
                them.
              </p>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

const EVENT_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger' | 'success'> = {
  SUBMITTED: 'neutral',
  RESUBMITTED: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  RETURNED: 'warning',
  WITHDRAWN: 'neutral',
};

/**
 * The full conversation, resubmissions included — spec 5.8.
 *
 * Built from `correction_event` rather than the request's status, which only
 * remembers the latest transition and would erase every return that was later
 * resubmitted.
 */
export function Timeline({ events }: { events: RequestDetail['events'] }) {
  if (events.length === 0) return <EmptyState title="No events recorded yet." />;

  return (
    <ol className="space-y-3">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-slate-200 pl-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={EVENT_TONE[e.action] ?? 'neutral'}>{e.action}</Badge>
            <span className="text-sm text-slate-800">{orDash(e.actorName)}</span>
            <span className="text-xs text-slate-500">{formatDateTime(e.createdAt)}</span>
          </div>
          {e.remarks ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{e.remarks}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function VersionTrail({ versions }: { versions: RequestDetail['versions'] }) {
  if (versions.length === 0) {
    return <p className="text-sm text-slate-500">No corrections have been applied to this record.</p>;
  }

  return (
    <ul className="space-y-2">
      {versions.map((v) => (
        <li key={v.version} className="flex flex-wrap items-baseline gap-2 text-sm">
          <span className="font-mono text-xs text-slate-500">v{v.version}</span>
          <span className="text-slate-800">{orDash(v.note)}</span>
          <span className="text-xs text-slate-500">{formatDateTime(v.changedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-sm text-slate-600 underline underline-offset-2 hover:text-slate-900">
      {children}
    </Link>
  );
}
