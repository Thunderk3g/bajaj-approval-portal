import type { Metadata } from 'next';
import Link from 'next/link';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { getVerifierSummary } from '@/lib/verification/queries';
import { ageInDays, formatDateTime } from '@/lib/format';
import { Alert, Card, LinkButton, PageHeader, StatCard } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Verifier dashboard · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

const n = (value: number) => value.toLocaleString('en-IN');

const QUEUE = '/verifier/queue';

export default async function VerifierDashboardPage() {
  const user = await requireRoleOrRedirect('verifier');
  const summary = await getVerifierSummary(user.id);
  const oldestDays = summary.oldestPendingAt ? ageInDays(summary.oldestPendingAt) : null;

  return (
    <section>
      <PageHeader
        title="Verifier dashboard"
        description="Every correction a salesperson raises passes through here before an approver can act on it."
        actions={
          <>
            <LinkButton href="/verifier/history">History</LinkButton>
            <LinkButton href={QUEUE} variant="primary">
              Open the queue
            </LinkButton>
          </>
        }
      />

      {/* A pending request with no proof cannot be verified against anything.
          It is the one queue condition working harder does not clear — the
          verifier has to return it — so it gets its own banner rather than
          being buried as a column in the table. */}
      {summary.missingProof > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`${n(summary.missingProof)} request${summary.missingProof === 1 ? ' has' : 's have'} no proof attached`}
          >
            There is nothing to check these against. Return them with a note asking for the
            document —{' '}
            <Link href={QUEUE} className="font-medium underline">
              open the queue
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      {oldestDays !== null && oldestDays >= 8 ? (
        <div className="mb-4">
          <Alert tone="warning" title={`The oldest request has been waiting ${n(oldestDays)} days`}>
            A rep cannot raise another correction on the same field while one is open, so a request
            sitting here blocks them. The queue is ordered oldest first.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Awaiting verification"
          value={n(summary.pending)}
          hint="Yours to check"
          tone={summary.pending > 0 ? 'warning' : 'success'}
          href={QUEUE}
        />
        <StatCard
          label="Oldest waiting"
          value={oldestDays === null ? '—' : `${n(oldestDays)}d`}
          hint={
            summary.oldestPendingAt ? formatDateTime(summary.oldestPendingAt) : 'Queue is empty'
          }
          tone={oldestDays !== null && oldestDays >= 8 ? 'danger' : 'default'}
          href={QUEUE}
        />
        {/* Downstream of this queue. A number that only grows means the approver
            stage has stalled behind the verifier, which is invisible from the
            "awaiting verification" figure alone. */}
        <StatCard
          label="With approvers"
          value={n(summary.verified)}
          hint="Verified, awaiting a decision"
          href={`${QUEUE}?scope=VERIFIED`}
        />
        <StatCard
          label="Verified this week"
          value={n(summary.verifiedThisWeekMine)}
          hint={`${n(summary.verifiedThisWeekAll)} across all verifiers`}
          tone="success"
          href="/verifier/history?mine=1"
        />
      </div>

      <div className="mt-4">
        <Card
          title="What verification is for"
          description="The stage exists so a correction is checked against its evidence by someone other than the person who raised it and the person who applies it."
        >
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-slate-600">
            <li>
              <strong className="text-slate-800">Verify</strong> — the proof supports the proposed
              value and the request targets the right record. The request moves to the approver
              queue. Nothing on the record changes yet.
            </li>
            <li>
              <strong className="text-slate-800">Return</strong> — the proof is missing, unreadable
              or does not support the value. The request goes back to the rep on the same timeline,
              and they can edit it and resubmit.
            </li>
            <li>
              There is no reject here. If a correction should not go ahead at all, return it with a
              reason; only an approver can close a request permanently.
            </li>
          </ul>
        </Card>
      </div>
    </section>
  );
}
