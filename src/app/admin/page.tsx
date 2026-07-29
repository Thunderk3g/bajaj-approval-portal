import type { Metadata } from 'next';
import Link from 'next/link';
import { requireRole } from '@/lib/auth/rbac';
import { getAdminDashboard } from '@/lib/dashboard/admin';
import { GAP_LABELS, GAP_TYPES } from '@/lib/records/gaps';
import { formatDateTime, orDash } from '@/lib/format';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  StatCard,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';

export const metadata: Metadata = {
  title: 'Admin dashboard · Sales Data Review Portal',
};

const n = (value: number) => value.toLocaleString('en-IN');

/**
 * The gap filter vocabulary the record list is expected to honour: a GapType
 * for one gap, or ANY for "carries at least one". Both are the same predicates
 * the counts above them were produced by, so a click always lands on exactly
 * the rows that were counted.
 */
const RECORDS = '/admin/records';
const gapHref = (gap: string) => `${RECORDS}?gap=${gap}`;

export default async function AdminDashboardPage() {
  // The layout already authorized this segment. Re-checking here is the rule of
  // spec section 4.1, not belt-and-braces: a page must never rely on something
  // upstream having run.
  await requireRole('admin');

  const data = await getAdminDashboard();
  const { records, batches, corrections } = data;

  return (
    <section>
      <PageHeader
        title="Admin dashboard"
        description="Import health, the reconciliation workload, and what the portal has been doing."
        actions={
          <>
            <LinkButton href="/admin/uploads">Uploads</LinkButton>
            <LinkButton href="/admin/records" variant="primary">
              Browse records
            </LinkButton>
          </>
        }
      />

      {records.anomalies > 0 ? (
        <div className="mb-6">
          <Alert
            tone="danger"
            title={`${n(records.anomalies)} issued ${
              records.anomalies === 1 ? 'application has' : 'applications have'
            } no policy number`}
          >
            An ISSUED application with no policy number cannot be reconciled against the core
            system at all — unlike a missing AutoPay flag, there is nothing to compare. These are
            the sharpest signal in the data and there are only ever a handful.{' '}
            <Link href={gapHref('MISSING_POLICY_NO')} className="font-medium underline">
              Review them
            </Link>
            .
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Records"
          value={n(records.total)}
          hint={`${n(records.issued)} issued`}
          href={RECORDS}
        />
        <StatCard
          label="Issued rows with a gap"
          value={n(records.withGap)}
          hint={`across ${n(records.repsWithGap)} rep${records.repsWithGap === 1 ? '' : 's'}`}
          tone={records.withGap > 0 ? 'warning' : 'default'}
          href={gapHref('ANY')}
        />
        {/* Both review stages, not just the first.

            This card counted `corrections.pending` alone, which is PENDING —
            requests still with a VERIFIER. A request that had been verified and
            was sitting with an approver counted nowhere on this dashboard, so
            the admin's headline read "0 pending" while corrections were in
            flight. The hint splits the number rather than hiding the split,
            because "3 in flight" and "3 stuck at the same stage" call for
            different action. */}
        <StatCard
          label="Corrections in flight"
          value={n(corrections.pending + corrections.verified)}
          hint={`${n(corrections.pending)} with a verifier · ${n(corrections.verified)} with an approver · ${n(corrections.returned)} returned to reps`}
          tone={corrections.pending + corrections.verified > 0 ? 'warning' : 'default'}
          href="/admin/corrections?status=PENDING"
        />
        <StatCard
          label="Duplicate rows staged"
          value={n(data.duplicateRows)}
          hint="Never committed to the master table"
          tone={data.duplicateRows > 0 ? 'warning' : 'default'}
          href="/admin/uploads"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card
          title="Reconciliation workload"
          description="Counted only on ISSUED rows — a blank on a pending application is correct, not broken."
        >
          <Table>
            <thead>
              <tr>
                <Th>Gap</Th>
                <Th className="text-right">Rows</Th>
              </tr>
            </thead>
            <tbody>
              {GAP_TYPES.map((type) => (
                <tr key={type}>
                  <Td>
                    <Link href={gapHref(type)} className="font-medium text-slate-900 hover:underline">
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
        </Card>

        <Card
          title="Upload batches"
          description={
            batches.lastCommittedAt
              ? `Last commit ${formatDateTime(batches.lastCommittedAt)}`
              : 'Nothing committed yet'
          }
          actions={<LinkButton href="/admin/uploads">All uploads</LinkButton>}
        >
          {batches.total === 0 ? (
            <EmptyState
              title="No uploads yet"
              description="Import the master workbook to populate every figure on this page."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Status</Th>
                  <Th className="text-right">Batches</Th>
                </tr>
              </thead>
              <tbody>
                {batches.byStatus.map((row) => (
                  <tr key={row.status}>
                    <Td>
                      <StatusBadge status={row.status} />
                    </Td>
                    <Td className="text-right tabular-nums">{n(row.count)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <Card
          title="Recent activity"
          description="From the append-only audit log."
          actions={<LinkButton href="/admin/audit">Full audit log</LinkButton>}
        >
          {data.activity.length === 0 ? (
            <EmptyState title="No activity recorded yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Actor</Th>
                </tr>
              </thead>
              <tbody>
                {data.activity.map((entry) => (
                  <tr key={entry.id}>
                    <Td className="whitespace-nowrap text-slate-600">
                      {formatDateTime(entry.createdAt)}
                    </Td>
                    <Td>
                      <Badge>{entry.action}</Badge>
                    </Td>
                    <Td className="text-slate-600">{entry.entityType}</Td>
                    <Td className="text-slate-600">{orDash(entry.actorEmail)}</Td>
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
