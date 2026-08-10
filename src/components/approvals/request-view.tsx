import type { ReactNode } from 'react';
import Link from 'next/link';
import { Alert, Badge, Card, EmptyState, StatusBadge, cx } from '@/components/ui';
import { formatDate, formatDateTime, formatMoney, orDash } from '@/lib/format';
import { apiPath } from '@/lib/nav';
import { CATEGORY_LABELS, type CorrectionCategory } from '@/lib/approvals/schemas';
import type { MappingContext, RequestDetail } from '@/lib/approvals/queries';

/**
 * The read-only half of the decision screen.
 *
 * Server Components throughout: none of this is interactive, and rendering it on
 * the server keeps the full record — premium figures included — out of the
 * client bundle.
 *
 * The layout is built around one fact: a reviewer works this screen all day, and
 * the question every visit asks is "what does it say now, and what is being asked
 * instead". Those two values are the largest thing on the page and sit above
 * everything else, so answering it never costs a scroll.
 */

/** 10px uppercase, the label voice used everywhere on this screen. */
const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.07em]';

export function CategoryBadge({ category }: { category: string }) {
  const tone =
    category === 'MAPPING' ? 'warning' : category === 'AUTOPAY' ? 'info' : ('neutral' as const);
  return <Badge tone={tone}>{CATEGORY_LABELS[category as CorrectionCategory] ?? category}</Badge>;
}

/**
 * The decision screen's own heading, in place of {@link PageHeader}.
 *
 * The application number IS the title here, and it is an identifier — so it is
 * monospaced and set larger than a page title elsewhere, because a reviewer
 * arriving from a queue row needs to confirm at a glance that they opened the
 * one they clicked.
 */
export function RequestHero({
  appsNo,
  backHref,
  backLabel,
  badges,
  summary,
}: {
  appsNo: string;
  backHref: string;
  backLabel: string;
  badges?: ReactNode;
  summary?: ReactNode;
}) {
  return (
    <div className="mb-4">
      <BackLink href={backHref}>← {backLabel}</BackLink>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <h1 className="font-mono text-[23px] font-semibold leading-none tracking-tight text-slate-900">
          {appsNo}
        </h1>
        {badges}
      </div>

      {summary ? (
        <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-slate-600">{summary}</p>
      ) : null}
    </div>
  );
}

/**
 * Reading on the left, deciding on the right.
 *
 * The decision panel is sticky because the reading column is long by design —
 * proof, record, chain, timeline — and a reviewer who has finished reading should
 * not have to scroll back up to act. Below `lg` the two stack, and the decision
 * lands last, after everything it is a decision about.
 */
export function ReviewLayout({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">{children}</div>
      <div className="space-y-4 lg:sticky lg:top-4">{aside}</div>
    </div>
  );
}

/**
 * Original beside proposed, with the record's live value as the tiebreaker.
 *
 * `original_value` is a snapshot taken when the request was submitted. If the
 * record has moved since — a re-import, an admin edit, another approved
 * correction — approving still overwrites whatever is there now, so the drift is
 * surfaced rather than hidden behind a stale "from" column.
 *
 * Both values are set at 26px, which is the largest type on the screen. This is
 * the comparison the whole page exists for; rendering it at body size put it on
 * equal footing with the product name.
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
        <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className={cx(LABEL, 'text-slate-500')}>Current value on the record</p>
          <p className="mt-2 break-words font-mono text-[26px] font-semibold leading-tight tracking-tight text-slate-900">
            {orDash(liveValue)}
          </p>
          {drifted ? (
            <p className="mt-2 text-[12px] leading-snug text-amber-700">
              At submission this read{' '}
              <span className="font-mono">{orDash(submittedOriginal)}</span>. The record has changed
              since.
            </p>
          ) : (
            <p className="mt-2 text-[12px] leading-snug text-slate-500">
              Unchanged since the request was raised.
            </p>
          )}
        </div>

        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className={cx(LABEL, 'text-emerald-700')}>Proposed value</p>
          <p className="mt-2 break-words font-mono text-[26px] font-semibold leading-tight tracking-tight text-emerald-900">
            {orDash(proposed)}
          </p>
          <p className="mt-2 text-[12px] leading-snug text-emerald-800">
            Written only when the final rung approves. Nothing before that touches the record.
          </p>
        </div>
      </div>

      {description ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <p className={cx(LABEL, 'text-slate-500')}>Submitter&rsquo;s note</p>
          <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-800">
            {description}
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/** Label left, value right, at half the width of a full-page detail row. */
function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3 border-b border-slate-100 py-1.5">
      <dt className={cx(LABEL, 'w-[104px] shrink-0 pt-[3px] text-slate-500')}>{label}</dt>
      <dd className="min-w-0 flex-1 text-[13px] text-slate-900">{children}</dd>
    </div>
  );
}

export function RecordContext({ record }: { record: RequestDetail['record'] }) {
  return (
    <Card title="Record context" description={`Version ${record.currentVersion}`}>
      {/* Two columns, because twelve full-width rows is a screen of its own and
          none of these is the thing being decided — they are the context that
          says the right record was opened. */}
      <dl className="grid gap-x-6 sm:grid-cols-2">
        <Row label="Application no.">
          <span className="font-mono">{record.appsNo}</span>
        </Row>
        <Row label="Policy no.">
          <span className="font-mono">{orDash(record.policyNo)}</span>
        </Row>
        <Row label="Client">{orDash(record.clientName)}</Row>
        <Row label="Status">
          <StatusBadge status={record.status} />
          {record.status2 ? <span className="ml-2 text-slate-600">{record.status2}</span> : null}
        </Row>
        <Row label="Product">
          {orDash(record.productName)}
          {record.productType ? <span className="text-slate-500"> · {record.productType}</span> : null}
        </Row>
        <Row label="Issued date">{formatDate(record.issuedDate)}</Row>
        <Row label="Login date">{formatDate(record.loginDate)}</Row>
        <Row label="FP / ANP">
          <span className="tabular-nums">
            {formatMoney(record.fp)} / {formatMoney(record.anp)}
          </span>
        </Row>
        <Row label="AutoPay">{orDash(record.autopay)}</Row>
        <Row label="Owner">
          <span className="font-mono">{record.smId}</span>
          <span className="text-slate-600"> · {orDash(record.smName)}</span>
        </Row>
        <Row label="TL / CCM">
          {orDash(record.tlName)} / {orDash(record.ccmName)}
        </Row>
        <Row label="Location">{orDash(record.location)}</Row>
      </dl>
    </Card>
  );
}

/**
 * Both reps side by side — spec 7.2, with direction from 2026-07-29 spec 7.
 *
 * The approver decides alone; the losing rep is notified, not consulted. Showing
 * both identities is what makes that decision an informed one rather than a
 * rubber stamp on an SM_ID string.
 *
 * Direction is shown because the two parties alone no longer identify the
 * request. The same pair of SM_IDs describes a rep asking for a sale and a rep
 * giving one away, and which it is changes what the reviewer should check: a
 * claim needs proof the sale was the claimant's work, a transfer needs the
 * destination to be the right rep. Without it the panel shows two names and no
 * indication of who is asking for what.
 */
export function MappingPanel({
  mapping,
  direction,
}: {
  mapping: MappingContext;
  direction: string | null;
}) {
  const isTransfer = direction === 'TRANSFER_OUT';
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
        'rounded-md border p-3',
        tone === 'claim' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50',
      )}
    >
      <p className={cx(LABEL, tone === 'claim' ? 'text-emerald-700' : 'text-slate-500')}>
        {heading}
      </p>
      <p
        className={cx(
          'mt-1.5 font-mono text-[15px] font-semibold',
          tone === 'claim' ? 'text-emerald-900' : 'text-slate-900',
        )}
      >
        {smId}
      </p>
      {recordName !== undefined ? (
        <p className="mt-1 text-[12px] text-slate-700">On the record: {orDash(recordName)}</p>
      ) : null}
      <p className="mt-0.5 text-[12px] text-slate-700">
        Roster: {inRoster ? orDash(rosterName) : <span className="text-amber-700">not listed</span>}
      </p>
      <p className="mt-0.5 text-[11px] text-slate-500">
        Portal account: {account ? `${account.name} (${account.email})` : 'none'}
      </p>
    </div>
  );

  return (
    <Card
      title={isTransfer ? 'Mapping transfer — both books' : 'Mapping claim — both books'}
      description={
        isTransfer
          ? 'The current owner is sending this sale away. Approving moves it; the receiving rep was told at submission and is not asked to agree.'
          : 'Approving moves the sale. Both reps are notified; the losing rep is not asked to agree.'
      }
    >
      <p className="mb-3 text-[12px] text-slate-600">
        {isTransfer ? (
          <>
            <span className="font-mono">{mapping.currentSmId}</span> raised this and is giving the
            sale away.
          </>
        ) : (
          <>
            <span className="font-mono">{mapping.claimSmId}</span> raised this and is asking for the
            sale.
          </>
        )}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Party
          heading={
            isTransfer ? 'Current owner — sending, raised this' : 'Current owner — loses the sale'
          }
          tone="current"
          smId={mapping.currentSmId}
          recordName={mapping.currentSmName}
          rosterName={mapping.currentRosterName}
          inRoster={mapping.currentInRoster}
          account={mapping.currentAccount}
        />
        <Party
          heading={
            isTransfer ? 'Receiving rep — gains the sale' : 'Claimant — gains the sale, raised this'
          }
          tone="claim"
          smId={mapping.claimSmId}
          rosterName={mapping.claimRosterName}
          inRoster={mapping.claimInRoster}
          account={mapping.claimAccount}
        />
      </div>

      {!mapping.claimInRoster ? (
        <div className="mt-3">
          <Alert
            tone="warning"
            title={
              isTransfer
                ? 'The receiving rep is not in the Manpower roster'
                : 'The claimant is not in the Manpower roster'
            }
          >
            Approving will move the record and clear <span className="font-mono">SM_Name</span>{' '}
            rather than write a name that may be wrong. Ask an admin to add the roster entry first
            if the name matters.
          </Alert>
        </div>
      ) : null}

      {/*
        A transfer can hand a policy to an SM_ID with no portal account, which a
        claim effectively cannot: a claimant is by definition signed in. The
        record would move into a book nobody can open, and the receiving rep
        would never see the notification either.
      */}
      {isTransfer && !mapping.claimAccount ? (
        <div className="mt-3">
          <Alert tone="warning" title="The receiving rep has no active portal account">
            The sale would move into a book nobody can sign in to see, and no arrival notice can be
            delivered. Check the SM ID is right before approving.
          </Alert>
        </div>
      ) : null}
    </Card>
  );
}

export function ProofList({ attachments }: { attachments: RequestDetail['attachments'] }) {
  if (attachments.length === 0) {
    return (
      <Card title="Proof (0)">
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
      {/*
        Thumbnails in a grid, not a column of full-size previews.

        The previews used to run to 384px each, so three attachments pushed the
        record, the chain and the timeline a screen and a half down — on the one
        page where everything is supposed to be visible together. A thumbnail is
        enough to tell a branch visitor log from a signed proposal; the full
        document is one click away and opens in the browser's own viewer.
      */}
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {attachments.map((a) => (
          <li key={a.id} className="overflow-hidden rounded-md border border-slate-200">
            <a
              href={apiPath(`/api/proofs/${a.id}`)}
              target="_blank"
              rel="noreferrer"
              className="block hover:bg-slate-50"
            >
              {a.mimeType.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={apiPath(`/api/proofs/${a.id}`)}
                  alt={a.originalName}
                  className="h-28 w-full border-b border-slate-200 bg-slate-100 object-contain"
                />
              ) : (
                <div className="flex h-28 items-center justify-center border-b border-slate-200 bg-slate-100">
                  <span className="font-mono text-[11px] text-slate-400">
                    {a.mimeType.split('/').pop()?.toUpperCase() ?? 'FILE'}
                  </span>
                </div>
              )}

              <div className="px-2.5 py-2">
                <p
                  className="truncate text-[12px] font-medium text-slate-900"
                  title={a.originalName}
                >
                  {a.originalName}
                </p>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {Math.max(1, Math.round(a.sizeBytes / 1024))} KB · {formatDateTime(a.uploadedAt)}
                </p>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Must cover every value of `eventActionEnum`; anything missing falls back to
 * `neutral`.
 *
 * VERIFIED was missing, and this is the timeline an approver reads to answer
 * "has a verifier already checked this" before deciding. A colourless entry is
 * exactly the one you skim past, on the one screen where skimming past it is the
 * mistake the two-stage gate exists to prevent.
 */
const EVENT_TONE: Record<string, 'neutral' | 'info' | 'warning' | 'danger' | 'success'> = {
  SUBMITTED: 'neutral',
  RESUBMITTED: 'info',
  VERIFIED: 'info',
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
    <ol className="space-y-2.5">
      {events.map((e) => (
        <li key={e.id} className="border-l-2 border-slate-200 pl-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={EVENT_TONE[e.action] ?? 'neutral'}>{e.action}</Badge>
            <span className="text-[13px] text-slate-800">{orDash(e.actorName)}</span>
            <span className="text-[11px] text-slate-500">{formatDateTime(e.createdAt)}</span>
          </div>
          {e.remarks ? (
            <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-600">
              {e.remarks}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function VersionTrail({ versions }: { versions: RequestDetail['versions'] }) {
  if (versions.length === 0) {
    return (
      <p className="text-[13px] text-slate-500">No corrections have been applied to this record.</p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {versions.map((v) => (
        <li key={v.version} className="flex flex-wrap items-baseline gap-2 text-[13px]">
          <span className="font-mono text-[11px] text-slate-500">v{v.version}</span>
          <span className="min-w-0 flex-1 text-slate-800">{orDash(v.note)}</span>
          <span className="text-[11px] text-slate-500">{formatDateTime(v.changedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-[12px] text-slate-600 underline underline-offset-2 hover:text-slate-900"
    >
      {children}
    </Link>
  );
}
