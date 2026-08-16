import { notFound } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { Alert, Badge, Card, DetailRow, StatusBadge } from '@/components/ui';
import { ageInDays, formatDateTime, orDash } from '@/lib/format';
import { getRequestDetail } from '@/lib/approvals/queries';
import { previewTarget } from '@/lib/approvals/apply';
import { openStageFor } from '@/lib/workflows/engine';
import { liveValueDrifted } from '@/lib/verification/apply';
import { VerifyForm } from '@/components/verification/verify-form';
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
 * The verification screen — 2026-07-28 spec section 3.8.
 *
 * Deliberately the same layout as the approver's and the managers': the
 * comparison at the top, then the record, the proof, the chain and the timeline
 * in one reading column, with the decision sticky beside them. Verification is a
 * reading task, and splitting the proof onto a second screen would make "did I
 * actually look at it" a matter of discipline rather than of layout.
 */
export default async function VerifyRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireRole('verifier');

  const { id } = await params;
  const detail = await getRequestDetail(viewer, id);
  if (!detail) notFound();

  const { request, record, mapping } = detail;
  const preview = previewTarget(request, record);
  const drift = await liveValueDrifted(request.id);
  // The OPEN RUNG, not the status. `status === 'PENDING'` described rung zero,
  // which was the verifier's only while every chain was two rungs long. On
  // `ISSUANCE_DATE` (V1 → V2 → APPROVER) a request this verifier can decide at
  // V2 is `VERIFIED`, and this screen used to tell them it was with an approver
  // and hide the form — leaving the rung open with nothing in the product able
  // to close it.
  const stage = await openStageFor(request.id, viewer);
  const isMine = stage?.isMine ?? false;
  const age = ageInDays(request.submittedAt);

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

  // Transfers only. A claimant necessarily has an account — they signed in to
  // raise the claim — so this can only be reached by a push, where the
  // destination is named by someone else and may be a rep who has never had
  // one. The record would move into a book nobody can open.
  if (mapping && request.direction === 'TRANSFER_OUT' && !mapping.claimAccount) {
    cautions.push(
      `${mapping.claimSmId} has no active portal account, so the sale would move into a book nobody can sign in to see and no arrival notice could be delivered.`,
    );
  }

  return (
    <>
      <RequestHero
        appsNo={request.appsNo}
        backHref="/verifier/queue"
        backLabel="Verification queue"
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
            <span className="font-mono">{request.smId}</span>)
            {detail.periodLabel ? ` · ${detail.periodLabel}` : ''}.
          </>
        }
      />

      {preview.problem ? (
        <div className="mb-4">
          <Alert tone="danger" title="This request cannot be applied as it stands">
            {preview.problem} Return it to the submitter with a note asking for a corrected value —
            an approver would only hit the same error.
          </Alert>
        </div>
      ) : null}

      <ReviewLayout
        aside={
          <>
            <Card
              title="Your decision"
              description={
                isMine
                  ? `Step ${(stage?.sequence ?? 0) + 1} of ${request.totalStages} — nothing is written yet.`
                  : undefined
              }
            >
              {isMine ? (
                <VerifyForm requestId={request.id} caution={cautions[0] ?? null} />
              ) : (
                <div className="space-y-3">
                  <Alert tone="info">
                    {stage
                      ? `This request is open at the ${stage.stageKey} step, which is not yours to decide.`
                      : 'This request is finished — there is no open step left on it.'}{' '}
                    {request.status === 'RETURNED'
                      ? 'It is with the submitter, who can edit and resubmit it on this same request.'
                      : ''}
                  </Alert>
                  <dl>
                    <DetailRow label="Verified by">{orDash(detail.verifierName)}</DetailRow>
                    <DetailRow label="Verified at">{formatDateTime(request.verifiedAt)}</DetailRow>
                    <DetailRow label="Verifier remarks">
                      {orDash(request.verifierRemarks)}
                    </DetailRow>
                  </dl>
                </div>
              )}
            </Card>

            {/* Every caution, not just the first. The form shows one so the button
                is not buried; the rest belong beside it rather than nowhere. */}
            {isMine && cautions.length > 1
              ? cautions.slice(1).map((c) => (
                  <Alert key={c} tone="warning">
                    {c}
                  </Alert>
                ))
              : null}
          </>
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
