import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { Alert, Card, DetailRow, PageHeader, StatusBadge } from '@/components/ui';
import { formatDateTime, orDash } from '@/lib/format';
import { getRequestDetail } from '@/lib/approvals/queries';
import { previewTarget } from '@/lib/approvals/apply';
import { liveValueDrifted } from '@/lib/verification/apply';
import { VerifyForm } from '@/components/verification/verify-form';
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
 * The verification screen — 2026-07-28 spec section 3.8.
 *
 * Deliberately the same layout as the approver's: the comparison, the record,
 * the proof and the timeline on one page. Verification is a reading task, and
 * splitting the proof onto a second screen would make "did I actually look at
 * it" a matter of discipline rather than of layout.
 */
export default async function VerifyRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireRole('verifier');

  const { id } = await params;
  const detail = await getRequestDetail(id);
  if (!detail) notFound();

  const { request, record, mapping } = detail;
  const preview = previewTarget(request, record);
  const drift = await liveValueDrifted(request.id);
  const isMine = request.status === 'PENDING';

  // Ordered by what should stop a verifier first: no evidence at all, then a
  // record that has moved since the claim was made, then a roster gap that only
  // matters at approval time.
  const cautions: string[] = [];

  if (detail.attachments.length === 0) {
    cautions.push(
      'This request has no proof attached, so there is nothing to verify the proposed value against. Return it and ask for the document.',
    );
  }

  if (drift.drifted) {
    cautions.push(
      `The record now holds "${drift.live ?? '(empty)'}" for this field, but the request was raised against "${drift.claimed ?? '(empty)'}". A re-import or another approved correction has changed it since. Check whether this request is still the right change.`,
    );
  }

  if (mapping && !mapping.claimInRoster) {
    cautions.push(
      `${mapping.claimSmId} is not in the Manpower roster, so approving this will clear SM_Name rather than write a name that may be wrong.`,
    );
  }

  return (
    <>
      <PageHeader
        title={`Request ${request.appsNo}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <CategoryBadge category={request.category} />
            <StatusBadge status={request.status} />
            {detail.periodLabel ? (
              <span className="text-slate-500">· {detail.periodLabel}</span>
            ) : null}
            <span className="text-slate-500">
              Submitted {formatDateTime(request.submittedAt)} by {orDash(detail.submitterName)} (
              {request.smId})
            </span>
          </span>
        }
        actions={<BackLink href="/verifier/queue">Back to queue</BackLink>}
      />

      {preview.problem ? (
        <div className="mb-4">
          <Alert tone="danger" title="This request cannot be applied as it stands">
            {preview.problem} Return it to the submitter with a note asking for a corrected value —
            an approver would only hit the same error.
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

        <Card title="Verification">
          {isMine ? (
            <VerifyForm requestId={request.id} caution={cautions[0] ?? null} />
          ) : (
            <div className="space-y-3">
              <Alert tone={request.status === 'VERIFIED' ? 'info' : 'info'}>
                This request is <strong>{request.status}</strong> and is no longer awaiting
                verification.
                {request.status === 'VERIFIED'
                  ? ' It is with an approver, who decides whether to apply it.'
                  : request.status === 'RETURNED'
                    ? ' It is with the submitter, who can edit and resubmit it on this same request.'
                    : ''}
              </Alert>
              <dl>
                <DetailRow label="Verified by">{orDash(detail.verifierName)}</DetailRow>
                <DetailRow label="Verified at">{formatDateTime(request.verifiedAt)}</DetailRow>
                <DetailRow label="Verifier remarks">{orDash(request.verifierRemarks)}</DetailRow>
              </dl>
            </div>
          )}
        </Card>

        {/* Every caution, not just the first. The form shows one so the button
            is not buried; the rest belong on the page rather than nowhere. */}
        {isMine && cautions.length > 1
          ? cautions.slice(1).map((c) => (
              <Alert key={c} tone="warning">
                {c}
              </Alert>
            ))
          : null}

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
