import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  CATEGORY_LABELS,
  type CorrectionCategory,
  ISSUED_DATE_MIN,
  issuedDateMax,
} from '@/lib/corrections/schemas';
import { getMyRequest } from '@/lib/corrections/queries';
import { requireSalesActor } from '@/lib/corrections/session';
import { formatDateTime, orDash } from '@/lib/format';
import { ACCEPT_ATTRIBUTE, MAX_PROOFS_PER_REQUEST } from '@/lib/storage/files';
import { ResubmitForm, WithdrawButton } from '@/components/corrections/request-actions';
import { ProofList, RequestTimeline } from '@/components/corrections/request-detail-parts';
import { Alert, Badge, Card, StatusBadge } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Correction request · Sales Data Review Portal',
};

/** 10px uppercase, matching the reviewer screens. */
const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.07em]';

export default async function RequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireSalesActor();
  const { id } = await params;

  const detail = await getMyRequest(actor, id);

  // A request belonging to another rep and a request that does not exist are
  // the same answer. Anything else confirms the id was real.
  if (!detail) notFound();

  const { request, events, attachments, submitterName } = detail;
  const shown = request.status;
  const category = request.category as CorrectionCategory;
  /**
   * Read widened, write did not — `docs/ui-flows.md` §7: the manager is recorded
   * as the submitter, the rep as the owner, and only the manager can resubmit.
   *
   * This flag is presentation only. `resubmitCorrection` and `withdrawCorrection`
   * both go through `loadOwnRequest`, which is still keyed on `submitted_by`, so
   * hiding the controls and refusing the action are independent — a rep who
   * POSTs the server action directly is refused there whatever this renders.
   */
  const raisedByMe = request.submittedBy === actor.id;
  const withdrawable = raisedByMe && (shown === 'PENDING' || shown === 'RETURNED');

  return (
    <section>
      {/*
        The application number is the title, monospaced and large: a rep arrives
        here from a list of ten-digit codes and the first thing they have to
        confirm is that they opened the right one.
      */}
      <div className="mb-4">
        <Link
          href="/sales/requests"
          className="text-[12px] text-slate-600 underline underline-offset-2 hover:text-slate-900"
        >
          ← My requests
        </Link>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-[23px] font-semibold leading-none tracking-tight text-slate-900">
            {request.appsNo}
          </h1>
          <Badge tone={category === 'MAPPING' ? 'warning' : 'neutral'}>
            {CATEGORY_LABELS[category] ?? request.category}
          </Badge>
          <StatusBadge status={shown} />
        </div>

        <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-slate-600">
          {request.fieldLabel} · raised {formatDateTime(request.submittedAt)}
          {request.resubmissionCount > 0
            ? ` · resubmitted ${request.resubmissionCount}×, last ${formatDateTime(request.lastResubmittedAt)}`
            : ''}
          .
        </p>
      </div>

      {raisedByMe ? null : (
        <div className="mb-4">
          <Alert tone="info" title={`${submitterName ?? 'Your manager'} raised this for you`}>
            It concerns your book, so you can follow it here — but only{' '}
            {submitterName ?? 'the person who raised it'} can resubmit it if it comes back, add proof
            to it, or withdraw it.
          </Alert>
        </div>
      )}

      {shown === 'RETURNED' && request.approverRemarks ? (
        <div className="mb-4">
          <Alert tone="warning" title="The approver asked for a change">
            {request.approverRemarks}
          </Alert>
        </div>
      ) : null}

      {shown === 'APPROVED' ? (
        <div className="mb-4">
          <Alert tone="success" title="Applied to the record">
            {request.fieldLabel} now reads {orDash(request.proposedValue)}.
          </Alert>
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          {/* The one thing a returned request needs is the form that fixes it,
              so it sits above the history rather than under it. */}
          {shown === 'RETURNED' && raisedByMe ? (
            <ResubmitForm
              requestId={request.id}
              category={request.category}
              direction={request.direction}
              fieldLabel={request.fieldLabel}
              currentValue={request.proposedValue}
              currentDescription={request.description ?? ''}
              accept={ACCEPT_ATTRIBUTE}
              issuedDateMin={ISSUED_DATE_MIN}
              issuedDateMax={issuedDateMax()}
              attachmentsRemaining={Math.max(0, MAX_PROOFS_PER_REQUEST - attachments.length)}
            />
          ) : null}

          <Card
            title="Where it has got to"
            description="Every step this request has been through, and what was said at each."
          >
            <RequestTimeline events={events} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="The change">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className={`${LABEL} text-slate-500`}>Now</p>
                <p className="mt-1.5 break-words font-mono text-[18px] font-semibold leading-tight text-slate-900">
                  {orDash(request.originalValue)}
                </p>
              </div>
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <p className={`${LABEL} text-emerald-700`}>Asked for</p>
                <p className="mt-1.5 break-words font-mono text-[18px] font-semibold leading-tight text-emerald-900">
                  {orDash(request.proposedValue)}
                </p>
              </div>
            </div>

            {request.description ? (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <p className={`${LABEL} text-slate-500`}>
                  {raisedByMe ? 'Your note' : `Note from ${submitterName ?? 'the raiser'}`}
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-800">
                  {request.description}
                </p>
              </div>
            ) : null}

            {category === 'MAPPING' ? (
              <p className="mt-3 border-t border-slate-100 pt-3 text-[12px] leading-relaxed text-slate-500">
                {request.direction === 'TRANSFER_OUT'
                  ? `If this is approved the sale leaves your book and moves to ${request.proposedValue}, whose SM name is resolved from the Manpower roster. That rep has already been told it is coming; they cannot refuse it, and they are not asked to accept it — the reviewers decide.`
                  : 'If this is approved the sale moves to your SM ID and the SM name is resolved from the Manpower roster. The rep who currently holds it is told, not asked.'}
              </p>
            ) : null}
          </Card>

          <Card
            title="Proof you attached"
            description={`${attachments.length} of ${MAX_PROOFS_PER_REQUEST} documents. Every view is logged.`}
          >
            <ProofList attachments={attachments} />
          </Card>

          <Card title={raisedByMe ? 'If it comes back to you' : 'If it comes back'}>
            <p className="text-[13px] leading-relaxed text-slate-600">
              {raisedByMe
                ? 'A return at any step sends it to you with remarks and a form prefilled with these values. Resubmitting restarts the review from the first step — never from the middle.'
                : `A return at any step sends it back to ${submitterName ?? 'whoever raised it'}, who raised it, with remarks. You will be told, but the answer is theirs to give.`}
            </p>

            {withdrawable ? (
              <div className="mt-3">
                <WithdrawButton requestId={request.id} />
                <p className="mt-2 text-[11px] leading-snug text-slate-500">
                  Available until the final decision. Withdrawing releases the field so you can
                  raise a corrected request against it.
                </p>
              </div>
            ) : (
              <p className="mt-2 text-[11px] leading-snug text-slate-500">
                {raisedByMe
                  ? `This request is ${shown.toLowerCase()}, so there is nothing left to withdraw.`
                  : `Only ${submitterName ?? 'the person who raised it'} can withdraw this one.`}
              </p>
            )}
          </Card>
        </div>
      </div>
    </section>
  );
}
