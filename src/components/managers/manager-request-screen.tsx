import { notFound } from 'next/navigation';
import { eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { correctionRequestStage } from '@/db/schema';
import type { SessionUser } from '@/lib/auth/rbac';
import { Alert, Badge, Card, StatusBadge } from '@/components/ui';
import { ageInDays, formatDateTime, orDash } from '@/lib/format';
import { getRequestDetail } from '@/lib/approvals/queries';
import { previewTarget } from '@/lib/approvals/record-apply';
import { liveValueDrifted } from '@/lib/verification/apply';
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
import { ManagerDecisionForm } from './manager-decision-form';

/**
 * A manager reviewing the rung in front of them.
 *
 * Deliberately the same layout as the verifier's and the approver's, down to the
 * shared components: the comparison at the top, the record, the proof, the chain
 * and the timeline in one column, the decision sticky beside them. Reviewing is a
 * reading task, and a manager who is shown less than a verifier would be asked to
 * sign off on strictly less information.
 */
export async function ManagerRequestScreen({
  user,
  role,
  requestId,
}: {
  user: SessionUser;
  role: 'tl' | 'acm';
  requestId: string;
}) {
  const detail = await getRequestDetail(requestId);
  if (!detail) notFound();

  const { request, record, mapping } = detail;
  const preview = previewTarget(request, record);
  const drift = await liveValueDrifted(request.id);
  const age = ageInDays(request.submittedAt);

  // The open rung, and whether it is THIS manager's. Read rather than inferred
  // from the role: a chain can route to two different ACMs, and "an area manager
  // may act" is not the same claim as "you may act".
  const [active] = await db
    .select()
    .from(correctionRequestStage)
    .where(
      and(
        eq(correctionRequestStage.requestId, requestId),
        eq(correctionRequestStage.status, 'ACTIVE'),
      ),
    )
    .limit(1);

  const isMine = Boolean(active && active.assignedUserId === user.id);

  const cautions: string[] = [];

  if (detail.attachments.length === 0) {
    cautions.push(
      'This request has no proof attached, so there is nothing to check the proposed value against. Send it back and ask for the document.',
    );
  }

  if (drift.drifted) {
    cautions.push(
      `The record now holds "${drift.live ?? '(empty)'}" for this field, but the request was raised against "${drift.claimed ?? '(empty)'}". A re-import or another approved correction has changed it since.`,
    );
  }

  if (mapping && !mapping.claimInRoster) {
    cautions.push(
      `${mapping.claimSmId} is not in the Manpower roster, so approving this will clear SM_Name rather than write a name that may be wrong.`,
    );
  }

  return (
    <>
      <RequestHero
        appsNo={request.appsNo}
        backHref={`/${role}/queue`}
        backLabel="My approvals"
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
            {preview.problem} Send it back with a note asking for a corrected value — every later
            step would only hit the same error.
          </Alert>
        </div>
      ) : null}

      <ReviewLayout
        aside={
          <>
            <Card
              title="Your decision"
              description={
                active
                  ? `Step ${active.sequence + 1} of ${request.totalStages} — ${active.stageKey}`
                  : undefined
              }
            >
              {isMine && active ? (
                <ManagerDecisionForm
                  requestId={request.id}
                  stageKey={active.stageKey}
                  role={role}
                  caution={cautions[0] ?? null}
                />
              ) : (
                <Alert tone="info">
                  {active
                    ? `This request is at step "${active.stageKey}", which is not yours to decide. You can read it here, but only the person it was routed to can act.`
                    : `This request is ${request.status.toLowerCase()} and has no step waiting on anyone.`}
                </Alert>
              )}
            </Card>

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

        <ChainProgress requestId={requestId} />

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
