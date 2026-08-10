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
            {/* The upload is the act that starts a month, so it leads. Export is
                the other thing an admin comes to this page to do and everything
                else on it is a link out of a figure. */}
            <LinkButton href="/admin/uploads/new" variant="primary">
              New upload
            </LinkButton>
            <LinkButton href="/admin/exports">Export</LinkButton>
          </>
        }
      />

      {records.anomalies > 0 ? (
        <div className="mb-4">
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

      {/* 12px gutters, not 16: five figures across one band read as one row of
          numbers only while the gaps stay smaller than the cards' own padding. */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card
          title="Reconciliation workload"
          description="Counted only on ISSUED rows — a blank on a pending application is correct, not broken."
        >
          {/* A list, not a table. Two columns of label-and-count carry no header
              worth a row of their own, and a bordered <Table> inside a bordered
              Card draws the same box twice. `-m-4` cancels the card's body
              padding so the dividers run edge to edge, the way every panel in
              the design does. */}
          <ul className="-m-4 divide-y divide-slate-100">
            {GAP_TYPES.map((type) => (
              <li key={type} className="flex items-baseline justify-between gap-4 px-4 py-[9px]">
                <Link href={gapHref(type)} className="text-[13px] text-slate-800 hover:underline">
                  {GAP_LABELS[type]}
                </Link>
                <span className="text-[13px] tabular-nums text-slate-900">
                  {n(records.byGap[type])}
                </span>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-4 px-4 py-[9px]">
              <span className="text-[13px] font-medium text-slate-900">At least one gap</span>
              <span className="text-[13px] font-medium tabular-nums text-slate-900">
                {n(records.withGap)}
              </span>
            </li>
          </ul>
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
            <ul className="-m-4 divide-y divide-slate-100">
              {batches.byStatus.map((row) => (
                <li
                  key={row.status}
                  className="flex items-center justify-between gap-4 px-4 py-[9px]"
                >
                  <StatusBadge status={row.status} />
                  <span className="text-[13px] tabular-nums text-slate-900">{n(row.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card
          title="Recent activity"
          description="From the append-only audit log."
          actions={<LinkButton href="/admin/audit">Full audit log</LinkButton>}
        >
          {data.activity.length === 0 ? (
            <EmptyState title="No activity recorded yet" />
          ) : (
            // A fixed-width monospaced timestamp column, so eight entries read as
            // a chronology down one edge rather than a ragged left margin.
            <ul className="-m-4 divide-y divide-slate-100">
              {data.activity.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-[9px]">
                  <span className="w-28 shrink-0 font-mono text-[11px] text-slate-500">
                    {formatDateTime(entry.createdAt)}
                  </span>
                  <Badge>{entry.action}</Badge>
                  <span className="min-w-0 text-[13px] text-slate-700">
                    {entry.entityType}
                    {entry.entityId ? (
                      <span className="ml-1.5 font-mono text-[12px] text-slate-500">
                        {entry.entityId}
                      </span>
                    ) : null}
                  </span>
                  <span className="ml-auto text-[12px] text-slate-500">
                    {orDash(entry.actorEmail)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </section>
  );
}
