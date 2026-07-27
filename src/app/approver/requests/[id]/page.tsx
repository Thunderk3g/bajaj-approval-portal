import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { Alert, Card, DetailRow, PageHeader, StatusBadge } from '@/components/ui';
import { formatDateTime, orDash } from '@/lib/format';
import { getRequestDetail } from '@/lib/approvals/queries';
import { previewTarget } from '@/lib/approvals/apply';
import { DecisionForm } from '@/components/approvals/decision-form';
import {
  BackLink,
  CategoryBadge,
  Comparison,
  MappingPanel,
  ProofList,
  RecordContext,
  Timeline,
  VersionTrail,
} from '@/components/approvals/request-view';

export const dynamic = 'force-dynamic';

/**
 * The decision screen — spec section 9.
 *
 * Everything the approver needs to decide sits on one page: the comparison, the
 * record it lands on, the proof, and the whole event timeline. Splitting the
 * proof onto a second screen would make "did I actually look at it" a matter of
 * discipline rather than of layout.
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
  const isOpen = request.status === 'PENDING';

  const caution =
    mapping && !mapping.claimInRoster
      ? `${mapping.claimSmId} is not in the Manpower roster — approving will clear SM_Name rather than write a name that may be wrong.`
      : null;

  return (
    <>
      <PageHeader
        title={`Request ${request.appsNo}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CategoryBadge category={request.category} />
            <StatusBadge status={request.status} />
            <span className="text-slate-500">
              Submitted {formatDateTime(request.submittedAt)} by{' '}
              {orDash(detail.submitterName)} ({request.smId})
            </span>
          </span>
        }
        actions={<BackLink href="/approver/queue">Back to queue</BackLink>}
      />

      {preview.problem ? (
        <div className="mb-4">
          <Alert tone="danger" title="This request cannot be applied as it stands">
            {preview.problem} Return it to the submitter with a note asking for a corrected value.
          </Alert>
        </div>
      ) : null}

      <div className="space-y-4">
        <Comparison
          fieldLabel={preview.label || request.fieldLabel}
          submittedOriginal={request.originalValue}
          liveValue={preview.liveValue}
          proposed={request.proposedValue}
          description={request.description}
        />

        {mapping ? <MappingPanel mapping={mapping} /> : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <RecordContext record={record} />
          <ProofList attachments={detail.attachments} />
        </div>

        <Card title="Decision">
          {isOpen ? (
            <DecisionForm requestId={request.id} caution={caution} />
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

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Timeline" description="Every transition, resubmissions included.">
            <Timeline events={detail.events} />
          </Card>
          <Card title="Record version history">
            <VersionTrail versions={detail.versions} />
          </Card>
        </div>
      </div>
    </>
  );
}
