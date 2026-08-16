import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { Alert, Badge, Card, DetailRow, StatusBadge } from '@/components/ui';
import { ageInDays, formatDateTime, orDash } from '@/lib/format';
import { getRequestDetail } from '@/lib/approvals/queries';
import { previewTarget } from '@/lib/approvals/apply';
import { openStageFor } from '@/lib/workflows/engine';
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
  const viewer = await requireRole('approver');

  const { id } = await params;
  const detail = await getRequestDetail(viewer, id);
  if (!detail) notFound();

  const { request, record, mapping } = detail;
  const preview = previewTarget(request, record);
  const age = ageInDays(request.submittedAt);

  // The OPEN RUNG, not the status — the third and final version of this gate.
  //
  // It was `status === 'PENDING'`, which the verifier stage broke; then
  // `status === APPROVABLE_STATUS` (VERIFIED), which the N-stage engine broke in
  // the same way, because `advance` now sets VERIFIED after ANY non-final rung.
  // On `MAPPING_BETWEEN_TEAMS` (TL → ACM → V2 → ACM → APPROVER) a request parked
  // with a team leader is VERIFIED, so this screen offered the approve button
  // and the engine refused the click.
  //
  // Asking which rung is open ends the pattern: the button appears exactly when
  // `assertMayDecide` would allow it, because both now read the stage table.
  const stage = await openStageFor(request.id, viewer);
  const isOpen = stage?.isMine ?? false;

  // Open, but at somebody else's rung — work still climbing towards the approver
  // rather than a request that has been decided. Without the distinction the
  // approver is told a request they will later act on "cannot be decided again".
  const awaitingUpstream = Boolean(stage) && !isOpen;

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
            ) : awaitingUpstream ? (
              <Alert tone="info" title="Not yet with you">
                This request is open at the <strong>{stage?.stageKey}</strong> step
                {stage ? ` (${stage.sequence + 1} of ${request.totalStages})` : ''}. It reaches you
                once every step before yours has passed it. Nothing is required from you until then.
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
