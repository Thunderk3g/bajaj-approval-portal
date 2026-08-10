import Link from 'next/link';
import { Badge, EmptyState, StatusBadge, Table, Td, Th } from '@/components/ui';
import { formatDateTime, orDash } from '@/lib/format';
import { APPROVABLE_STATUS } from '@/lib/approvals/apply';
import type { HistoryRow, QueueRow } from '@/lib/approvals/queries';
import { CategoryBadge } from './request-view';

/**
 * Ageing is the queue's whole point of view.
 *
 * A count of pending requests says nothing about whether the queue is healthy;
 * one request sitting for eleven days is a worse failure than forty submitted
 * this morning, and only the age column makes that visible.
 */
function AgeBadge({ days }: { days: number }) {
  const tone = days >= 7 ? 'danger' : days >= 3 ? 'warning' : 'neutral';
  return (
    <Badge tone={tone}>
      {days} {days === 1 ? 'day' : 'days'}
    </Badge>
  );
}

/**
 * Shared by the approver and verifier queues.
 *
 * `basePath` is the only STRUCTURAL difference between them — same columns, same
 * ageing rules, same ordering. Copying the table for the second stage would mean
 * every future column had to be added twice, and the two would drift the first
 * time somebody forgot.
 *
 * `homeStatus` is the second difference, and it is not structural but semantic:
 * the two queues work on different statuses. It defaults to the approver's,
 * matching `basePath`, so the pair cannot be half-configured by a caller that
 * sets one and forgets the other.
 */
export function QueueTable({
  rows,
  basePath = '/approver',
  homeStatus = APPROVABLE_STATUS,
  selectable = false,
}: {
  rows: QueueRow[];
  basePath?: string;
  /** The status this queue exists to work on — chips are suppressed for it. */
  homeStatus?: string;
  /**
   * Renders the batch-selection column. Off by default, so the table is
   * unchanged anywhere it is read rather than worked.
   *
   * This component stays a SERVER component with this on. The checkboxes are
   * plain uncontrolled inputs named `requestIds`, and the client component that
   * wraps the table reads them off its own `<form>` — which is what keeps
   * `APPROVABLE_STATUS`, and through it `apply.ts` and the database client, out
   * of the browser bundle.
   */
  selectable?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing waiting on you"
        description="Requests arrive here when their current step resolves to you. Reps raise them from their own records; nothing you can do puts a row in this table. If you expected one, widen the scope or clear the search above."
      />
    );
  }

  return (
    <Table>
      <thead>
        <tr>
          {selectable ? (
            <Th className="w-8">
              <span className="sr-only">Select</span>
            </Th>
          ) : null}
          <Th>Age</Th>
          <Th>Application</Th>
          <Th>Category / field</Th>
          <Th>Change</Th>
          <Th>Submitter</Th>
          <Th>SM_ID</Th>
          <Th>Proof</Th>
          <Th>Submitted</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="hover:bg-slate-50">
            {/*
              A checkbox only on rows this queue can actually act on.

              In the OPEN scope the list mixes all three open statuses, and a
              batch of them would come back mostly failed — an approver
              selecting a PENDING row is asking for a decision the verifier gate
              refuses. An absent checkbox says that before the click rather than
              after it, and it says it in the same place the status chip does.
            */}
            {selectable ? (
              <Td>
                {r.status === homeStatus ? (
                  <input
                    type="checkbox"
                    name="requestIds"
                    value={r.id}
                    aria-label={`Select application ${r.appsNo}`}
                    className="h-4 w-4 accent-slate-900"
                  />
                ) : null}
              </Td>
            ) : null}
            <Td>
              <AgeBadge days={r.ageDays} />
            </Td>
            <Td>
              <Link
                href={`${basePath}/requests/${r.id}`}
                className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
              >
                {r.appsNo}
              </Link>
              <div className="mt-0.5 text-xs text-slate-500">{orDash(r.clientName)}</div>
              {/* The status chip is shown for anything that is not the queue's
                  own working state, so a mixed "everything open" list does not
                  look uniform when it is not.

                  `homeStatus` is a prop rather than the literal 'PENDING' it
                  used to be, because this table serves two queues whose working
                  states differ: the verifier acts on PENDING, the approver on
                  VERIFIED. Hardcoding PENDING inverted the signal for the
                  approver — every row in their default queue wore a redundant
                  VERIFIED chip, while in "everything open" the PENDING rows that
                  are NOT their job blended in unmarked and the VERIFIED rows
                  that ARE were flagged as the unusual ones. */}
              {r.status !== homeStatus ? (
                <div className="mt-1">
                  <StatusBadge status={r.status} />
                </div>
              ) : null}
            </Td>
            <Td>
              <CategoryBadge category={r.category} />
              {/*
                The sub-label carries the direction for a mapping request,
                because the field name alone ("SM ID") is identical for a claim
                and a transfer and tells the reviewer nothing about what they
                are being asked to check. Falls back to the field label for
                every other category, which is what it always showed.
              */}
              <div className="mt-0.5 text-xs text-slate-500">
                {r.direction === 'TRANSFER_OUT'
                  ? 'Transfer out'
                  : r.direction === 'CLAIM_IN'
                    ? 'Claim in'
                    : r.fieldLabel}
              </div>
            </Td>
            <Td>
              <span className="font-mono text-xs text-slate-500">{orDash(r.originalValue)}</span>
              <span className="px-1 text-slate-400" aria-label="becomes">
                →
              </span>
              <span className="font-mono text-xs font-medium text-slate-900">
                {orDash(r.proposedValue)}
              </span>
            </Td>
            <Td>
              {orDash(r.submitterName)}
              <div className="text-xs text-slate-500">{orDash(r.submitterEmail)}</div>
            </Td>
            <Td>
              <span className="font-mono text-xs">{r.smId}</span>
            </Td>
            <Td>
              {r.attachments > 0 ? (
                <Badge tone="neutral">{r.attachments}</Badge>
              ) : (
                <Badge tone="warning">none</Badge>
              )}
            </Td>
            <Td>
              <span className="text-xs text-slate-600">{formatDateTime(r.submittedAt)}</span>
              {r.resubmissionCount > 0 ? (
                <div className="mt-0.5 text-xs text-sky-700">
                  resubmitted ×{r.resubmissionCount}
                </div>
              ) : null}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function HistoryTable({
  rows,
  basePath = '/approver',
  actorLabel = 'Approver',
}: {
  rows: Array<HistoryRow | (Omit<HistoryRow, never> & { actorRole?: string | null })>;
  basePath?: string;
  actorLabel?: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title="No decisions match these filters." />;
  }

  return (
    <Table>
      <thead>
        <tr>
          <Th>Decided</Th>
          <Th>Decision</Th>
          <Th>Application</Th>
          <Th>Category / field</Th>
          <Th>Change</Th>
          <Th>{actorLabel}</Th>
          <Th>Remarks</Th>
          <Th>Now</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.eventId} className="hover:bg-slate-50">
            <Td>
              <span className="text-xs text-slate-600">{formatDateTime(r.decidedAt)}</span>
            </Td>
            <Td>
              <StatusBadge status={r.action} />
            </Td>
            <Td>
              <Link
                href={`${basePath}/requests/${r.requestId}`}
                className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
              >
                {r.appsNo}
              </Link>
              <div className="mt-0.5 text-xs text-slate-500">
                {orDash(r.submitterName)} · <span className="font-mono">{r.smId}</span>
              </div>
            </Td>
            <Td>
              <CategoryBadge category={r.category} />
              <div className="mt-0.5 text-xs text-slate-500">{r.fieldLabel}</div>
            </Td>
            <Td>
              <span className="font-mono text-xs text-slate-500">{orDash(r.originalValue)}</span>
              <span className="px-1 text-slate-400" aria-label="becomes">
                →
              </span>
              <span className="font-mono text-xs text-slate-900">{orDash(r.proposedValue)}</span>
            </Td>
            <Td>{orDash(r.actorName)}</Td>
            <Td className="max-w-xs">
              <span className="text-xs text-slate-700">{orDash(r.remarks)}</span>
            </Td>
            <Td>
              {/* A returned request that was resubmitted is PENDING again — the
                  decision stays in history, but its current state has moved on. */}
              <StatusBadge status={r.currentStatus} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
