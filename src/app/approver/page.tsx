import type { Metadata } from 'next';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/rbac';
import { getApproverDashboard, DECISION_ACTIONS } from '@/lib/dashboard/approver';
import { AGE_BUCKETS, THROUGHPUT_WINDOWS } from '@/lib/dashboard/ageing';
import { ageInDays, formatDateTime } from '@/lib/format';
import {
  Alert,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  StatCard,
  Table,
  Td,
  Th,
} from '@/components/ui';

export const metadata: Metadata = {
  title: 'Approver dashboard · Sales Data Review Portal',
};

const n = (value: number) => value.toLocaleString('en-IN');

const QUEUE = '/approver/queue';

const DECISION_LABELS: Record<string, string> = {
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned',
};

export default async function ApproverDashboardPage() {
  await requireRole('approver');

  const { queue, throughput } = await getApproverDashboard();
  const oldestDays = queue.oldestPendingAt ? ageInDays(queue.oldestPendingAt) : null;
  const stale = queue.ageing.STALE;

  return (
    <section>
      <PageHeader
        title="Approver dashboard"
        description="What is waiting, how long it has been waiting, and what has been decided."
        actions={
          <>
            <LinkButton href="/approver/history">History</LinkButton>
            <LinkButton href={QUEUE} variant="primary">
              Open the queue
            </LinkButton>
          </>
        }
      />

      {stale > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`${n(stale)} request${stale === 1 ? ' has' : 's have'} been waiting 8 days or more`}
          >
            A rep cannot correct a record while its request sits in the queue, and cannot raise a
            second request against the same field while one is open. The queue is ordered oldest
            first, so{' '}
            <Link href={QUEUE} className="font-medium underline">
              start at the top
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Queue depth"
          value={n(queue.pending)}
          hint="Awaiting your decision"
          tone={queue.pending > 0 ? 'warning' : 'success'}
          href={QUEUE}
        />
        <StatCard
          label="Oldest waiting"
          value={oldestDays === null ? '—' : `${n(oldestDays)}d`}
          // Measured from submission, not from verification: the rep has been
          // waiting since they filed, and an SLA that restarted at each stage
          // would report a three-week-old request as one day old.
          hint={queue.oldestPendingAt ? formatDateTime(queue.oldestPendingAt) : 'Queue is empty'}
          tone={oldestDays !== null && oldestDays >= 8 ? 'danger' : 'default'}
          href={QUEUE}
        />
        {/* Upstream of this dashboard. An approver whose own queue is empty
            while this climbs is blocked, not idle, and no other figure on the
            page distinguishes the two. */}
        <StatCard
          label="Awaiting verification"
          value={n(queue.awaitingVerification)}
          hint="With a verifier — not yours yet"
          href="/approver/queue?scope=PENDING"
        />
        <StatCard
          label="Decided this week"
          value={n(throughput.WEEK.TOTAL)}
          hint={`${n(throughput.DAY.TOTAL)} in the last 24 hours`}
          tone="success"
          href="/approver/history"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Queue ageing"
          description="Every pending request falls in exactly one band, so these sum to the queue depth."
        >
          {queue.pending === 0 ? (
            <EmptyState title="Nothing pending" description="The queue is clear." />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Waiting</Th>
                  <Th className="text-right">Requests</Th>
                </tr>
              </thead>
              <tbody>
                {/* Not links: the queue has no age filter, and it is already
                    sorted oldest first, so a band is a summary rather than a
                    view. A link that quietly ignored its parameter would be
                    worse than no link. */}
                {AGE_BUCKETS.map((bucket) => (
                  <tr key={bucket.id}>
                    <Td className="font-medium">{bucket.label}</Td>
                    <Td className="text-right tabular-nums">{n(queue.ageing[bucket.id])}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="Throughput"
          description="Counted from the decision timeline, so a resubmitted request still credits the decision already made on it."
        >
          <Table>
            <thead>
              <tr>
                <Th>Period</Th>
                {DECISION_ACTIONS.map((action) => (
                  <Th key={action} className="text-right">
                    {DECISION_LABELS[action]}
                  </Th>
                ))}
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {THROUGHPUT_WINDOWS.map((window) => (
                <tr key={window.id}>
                  <Td className="whitespace-nowrap">{window.label}</Td>
                  {DECISION_ACTIONS.map((action) => (
                    <Td key={action} className="text-right tabular-nums">
                      {n(throughput[window.id][action])}
                    </Td>
                  ))}
                  <Td className="text-right font-medium tabular-nums">
                    {n(throughput[window.id].TOTAL)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
    </section>
  );
}
