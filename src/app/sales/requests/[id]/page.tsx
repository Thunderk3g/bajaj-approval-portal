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
import { Alert, Card, DetailRow, PageHeader, StatusBadge } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Correction request · Sales Data Review Portal',
};

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

  const { request, events, attachments } = detail;
  const shown = request.status;
  const category = request.category as CorrectionCategory;

  return (
    <section>
      <PageHeader
        title={`Application ${request.appsNo}`}
        description={
          <>
            {CATEGORY_LABELS[category] ?? request.category}
            <span className="px-1.5 text-slate-300" aria-hidden="true">
              |
            </span>
            raised {formatDateTime(request.submittedAt)}
          </>
        }
        actions={
          <>
            <StatusBadge status={shown} />
            {shown === 'PENDING' || shown === 'RETURNED' ? (
              <WithdrawButton requestId={request.id} />
            ) : null}
          </>
        }
      />

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

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="The correction">
            <dl>
              <DetailRow label="Field">{request.fieldLabel}</DetailRow>
              <DetailRow label="Current value">
                <span className="text-slate-600">{orDash(request.originalValue)}</span>
              </DetailRow>
              <DetailRow label="Proposed value">
                <span className="font-medium">{orDash(request.proposedValue)}</span>
              </DetailRow>
              <DetailRow label="Description">{orDash(request.description)}</DetailRow>
              {request.resubmissionCount > 0 ? (
                <DetailRow label="Resubmitted">
                  {request.resubmissionCount}× — last {formatDateTime(request.lastResubmittedAt)}
                </DetailRow>
              ) : null}
              {category === 'MAPPING' ? (
                <DetailRow label="Note">
                  If this is approved the sale moves to your SM ID and the SM name is resolved from
                  the Manpower roster. The rep who currently holds it is told, not asked.
                </DetailRow>
              ) : null}
            </dl>
          </Card>

          <Card
            title="Proof"
            description={`${attachments.length} of ${MAX_PROOFS_PER_REQUEST} documents. Every view is logged.`}
          >
            <ProofList attachments={attachments} />
          </Card>

          {shown === 'RETURNED' ? (
            <ResubmitForm
              requestId={request.id}
              category={request.category}
              fieldLabel={request.fieldLabel}
              currentValue={request.proposedValue}
              currentDescription={request.description ?? ''}
              accept={ACCEPT_ATTRIBUTE}
              issuedDateMin={ISSUED_DATE_MIN}
              issuedDateMax={issuedDateMax()}
              attachmentsRemaining={Math.max(0, MAX_PROOFS_PER_REQUEST - attachments.length)}
            />
          ) : null}
        </div>

        <div className="lg:col-span-1">
          <Card title="History">
            <RequestTimeline events={events} />
          </Card>
        </div>
      </div>

      <p className="mt-4 text-sm">
        <Link href="/sales/requests" className="text-slate-600 underline underline-offset-2">
          Back to my requests
        </Link>
      </p>
    </section>
  );
}
