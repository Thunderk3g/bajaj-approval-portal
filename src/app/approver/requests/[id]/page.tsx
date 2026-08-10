import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { Alert, Badge, Card, DetailRow, StatusBadge } from '@/components/ui';
import { ageInDays, formatDateTime, orDash } from '@/lib/format';
import { getRequestDetail } from '@/lib/approvals/queries';
import { APPROVABLE_STATUS, previewTarget } from '@/lib/approvals/apply';
import { DecisionForm } from '@/components/approvals/decision-form';
import { ChainProgress } from '@/components/approvals/chain-progress';
import {
  CategoryBadge,
  Comparison,
  MappingPanel,
  ProofList,
  RecordContext,
  RequestHero,
  ReviewLayout,
  Timeline,
  VersionTrail,
} from '@/components/approvals/request-view';

export const dynamic = 'force-dynamic';

/**
 * The decision screen — spec section 9.
 *
 * Everything the approver needs to decide sits on one page, in the order the
 * question is asked: what is changing, on which record, on what evidence, how
 * far it has already climbed, and what has been said about it. The decision
 * itself sits sticky beside all of that, because the reading column is long and
 * scrolling back up to act is a way to act on the wrong screen.
 */
export default async function RequestDecisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole('approver');

  const { id } = await params;
  const detail = await getRequestDetail(id);
  if (!detail) notFound();

  const { request, record, mapping } = detail;
  const preview = previewTarget(request, record);
  const age = ageInDays(request.submittedAt);

  // APPROVABLE_STATUS, not a literal, and specifically not 'PENDING'.
  //
  // This read used to be `status === 'PENDING'`, which was correct until the
  // verifier stage landed and stopped being correct in the same commit. After it,
  // a request an approver may act on is VERIFIED — `decideWithin` locks on
  // `WHERE status = APPROVABLE_STATUS` — so the one state where approval is legal
  // was the one state that rendered "this request cannot be decided again". The
  // approver had no approve button precisely when the request was ready.
  //
  // Importing the constant rather than swapping one literal for another is the
  // actual fix: the gate now has a single definition, and a future change to it
  // moves this screen with it instead of leaving the two to disagree in silence.
  const isOpen = request.status === APPROVABLE_STATUS;

  // PENDING is no longer "decided" — it is waiting for the verifier, which is a
  // different sentence from the one the decided branch prints. Without this the
  // approver is told a request they will later act on "cannot be decided again".
  const awaitingVerification = request.status === 'PENDING';

  const caution =
    mapping && !mapping.claimInRoster
      ? `${mapping.claimSmId} is not in the Manpower roster — approving will clear SM_Name rather than write a name that may be wrong.`
      : null;

  return (
    <>
      <RequestHero
        appsNo={request.appsNo}
        backHref="/approver/queue"
        backLabel="Approval queue"
        badges={
          <>
            <CategoryBadge category={request.category} />
            <StatusBadge status={request.status} />
            <Badge tone={age >= 7 ? 'danger' : age >= 3 ? 'warning' : 'neutral'}>
              {age} {age === 1 ? 'day' : 'days'} old
            </Badge>
          </>
        }
        summary={
          <>
            Submitted {formatDateTime(request.submittedAt)} by{' '}
            <span className="font-medium text-slate-800">{orDash(detail.submitterName)}</span> (
            <span className="font-mono">{request.smId}</span>).
          </>
        }
      />

      {preview.problem ? (
        <div className="mb-4">
          <Alert tone="danger" title="This request cannot be applied as it stands">
            {preview.problem} Return it to the submitter with a note asking for a corrected value.
          </Alert>
        </div>
      ) : null}

      <ReviewLayout
        aside={
          <Card
            title="Your decision"
            description={
              isOpen ? 'Approving writes the record and closes the chain.' : undefined
            }
          >
            {isOpen ? (
              <DecisionForm requestId={request.id} caution={caution} />
            ) : awaitingVerification ? (
              <Alert tone="info" title="Not yet with you">
                A verifier has to check this request against its proof before it can be approved. It
                will appear in your queue once they do. Nothing is required from you until then.
              </Alert>
            ) : (
              <div className="space-y-3">
                <Alert tone={request.status === 'APPROVED' ? 'success' : 'info'}>
                  This request is <strong>{request.status}</strong> and cannot be decided again.
                  {request.status === 'RETURNED'
                    ? ' It is with the submitter, who can edit and resubmit it on this same request.'
                    : ''}
                </Alert>
                <dl>
                  <DetailRow label="Decided by">{orDash(detail.reviewerName)}</DetailRow>
                  <DetailRow label="Decided at">{formatDateTime(request.reviewedAt)}</DetailRow>
                  <DetailRow label="Remarks">{orDash(request.approverRemarks)}</DetailRow>
                  {request.appliedVersion ? (
                    <DetailRow label="Applied as">version {request.appliedVersion}</DetailRow>
                  ) : null}
                </dl>
              </div>
            )}
          </Card>
        }
      >
        <Comparison
          fieldLabel={preview.label || request.fieldLabel}
          submittedOriginal={request.originalValue}
          liveValue={preview.liveValue}
          proposed={request.proposedValue}
          description={request.description}
        />

        {mapping ? <MappingPanel mapping={mapping} direction={request.direction} /> : null}

        <RecordContext record={record} />

        <ProofList attachments={detail.attachments} />

        <ChainProgress requestId={request.id} />

        <Card title="Timeline" description="Every transition, resubmissions included.">
          <Timeline events={detail.events} />
        </Card>

        <Card title="Record version history">
          <VersionTrail versions={detail.versions} />
        </Card>
      </ReviewLayout>
    </>
  );
}
