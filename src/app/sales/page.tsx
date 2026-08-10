import type { Metadata } from 'next';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/rbac';
import { getSalesDashboard } from '@/lib/dashboard/sales';
import { GAP_LABELS, GAP_TYPES } from '@/lib/records/gaps';
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
  title: 'My dashboard · Sales Data Review Portal',
};

const n = (value: number) => value.toLocaleString('en-IN');

const RECORDS = '/sales/records';
const REQUESTS = '/sales/requests';
const gapHref = (gap: string) => `${RECORDS}?gap=${gap}`;
const statusHref = (status: string) => `${REQUESTS}?status=${status}`;

export default async function SalesDashboardPage() {
  // Spec section 4.1: the page authorizes itself. requireRole also re-reads the
  // role and SM_ID from the session store, so the scope below is never built
  // from anything a request could have carried in.
  const user = await requireRole('sales');
  const { records, requests, smId } = await getSalesDashboard(user);

  return (
    <section>
      <PageHeader
        title="My dashboard"
        description={
          <>
            Everything here is scoped to <span className="font-medium text-slate-900">{smId}</span>.
          </>
        }
        actions={
          <>
            <LinkButton href={REQUESTS}>My requests</LinkButton>
            <LinkButton href={gapHref('ANY')} variant="primary">
              Work the gaps
            </LinkButton>
          </>
        }
      />

      {requests.returned > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`${n(requests.returned)} request${
              requests.returned === 1 ? '' : 's'
            } returned to you`}
          >
            A returned request is waiting on you, not on the approver — it keeps its history and
            its proof, so edit what was asked for and resubmit rather than raising a new one.{' '}
            <Link href={statusHref('RETURNED')} className="font-medium underline">
              Open them
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="My records"
          value={n(records.total)}
          hint={`${n(records.issued)} issued`}
          href={RECORDS}
        />
        <StatCard
          label="Needing a fix"
          value={n(records.withGap)}
          hint="Issued rows with a missing field"
          tone={records.withGap > 0 ? 'warning' : 'success'}
          href={gapHref('ANY')}
        />
        {/* Both waiting stages in one figure. Showing only one of them would
            make the number drop when a request PROGRESSED from the verifier to
            the approver, which reads as a claim going missing. */}
        <StatCard
          label="Awaiting a decision"
          value={n(requests.open)}
          hint={
            requests.awaitingApproval > 0
              ? `${n(requests.awaitingApproval)} with an approver, ${n(requests.awaitingVerification)} with a verifier`
              : 'With a verifier'
          }
          href={statusHref('PENDING')}
        />
        <StatCard
          label="Returned to me"
          value={n(requests.returned)}
          hint="Waiting on you"
          tone={requests.returned > 0 ? 'danger' : 'default'}
          href={statusHref('RETURNED')}
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="My worklist"
          description="Only issued applications count as a gap — a blank on a pending application is correct."
        >
          {records.total === 0 ? (
            <EmptyState
              title="No records yet"
              description="Your records appear once an admin commits an upload containing your SM_ID."
            />
          ) : records.withGap === 0 ? (
            <EmptyState
              title="Nothing to reconcile"
              description="Every issued application in your book has an issuance date, a policy number and an AutoPay value."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Gap</Th>
                  <Th className="text-right">Records</Th>
                </tr>
              </thead>
              <tbody>
                {GAP_TYPES.map((type) => (
                  <tr key={type}>
                    <Td>
                      <Link
                        href={gapHref(type)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {GAP_LABELS[type]}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{n(records.byGap[type])}</Td>
                  </tr>
                ))}
                <tr>
                  <Td className="font-medium">At least one gap</Td>
                  <Td className="text-right font-medium tabular-nums">{n(records.withGap)}</Td>
                </tr>
              </tbody>
            </Table>
          )}
        </Card>

        <Card
          title="My correction requests"
          description="Every request you have raised, whatever became of it."
          actions={<LinkButton href={REQUESTS}>All requests</LinkButton>}
        >
          {requests.total === 0 ? (
            <EmptyState
              title="No requests raised yet"
              description="Open a record with a gap and propose the correct value, with proof attached."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Status</Th>
                  <Th className="text-right">Requests</Th>
                </tr>
              </thead>
              <tbody>
                {/* Every status the enum can hold, so these rows sum to the
                    total. A rep who adds them up and finds one short has no way
                    to tell which of their claims disappeared. */}
                {(
                  [
                    ['PENDING', 'With a verifier', requests.awaitingVerification],
                    ['VERIFIED', 'With an approver', requests.awaitingApproval],
                    ['RETURNED', 'Returned to me', requests.returned],
                    ['APPROVED', 'Approved', requests.approved],
                    ['REJECTED', 'Rejected', requests.rejected],
                    ['WITHDRAWN', 'Withdrawn by me', requests.withdrawn],
                  ] as const
                ).map(([status, label, count]) => (
                  <tr key={status}>
                    <Td>
                      <Link
                        href={statusHref(status)}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {label}
                      </Link>
                    </Td>
                    <Td className="text-right tabular-nums">{n(count)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </section>
  );
}
