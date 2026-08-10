import type { Metadata } from 'next';
import { requireRole } from '@/lib/auth/rbac';
import { listPeriodSummaries } from '@/lib/periods/queries';
import { formatDateTime, orDash } from '@/lib/format';
import {
  Alert,
  Badge,
  Card,
  PageHeader,
  StatCard,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { PeriodActions } from './period-actions';

export const metadata: Metadata = {
  title: 'Reconciliation periods · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

const n = (value: number) => value.toLocaleString('en-IN');

/**
 * The monthly cycle — 2026-07-28 spec section 4.
 *
 * Read-mostly. The normal path never touches this screen: committing next
 * month's workbook opens the new period and closes the old one, because the
 * upload IS the event that starts a month. This page exists for the exceptions —
 * closing early, and reopening a month closed by mistake.
 */
export default async function PeriodsPage() {
  await requireRole('admin');

  const periods = await listPeriodSummaries();
  const open = periods.find((p) => p.status === 'OPEN') ?? null;
  const totalOpenRequests = periods.reduce((sum, p) => sum + p.openRequests, 0);

  return (
    <section>
      <PageHeader
        title="Reconciliation periods"
        description="One calendar month each. Committing a workbook into a new month opens it and closes the previous one automatically — you only need this screen for the exceptions."
      />

      {periods.length === 0 ? (
        <Alert tone="info" title="No periods yet">
          The first period is created when you commit an upload. Until then, corrections are
          unconstrained by any cycle — records imported before periods existed stay correctable
          indefinitely, which is deliberate.
        </Alert>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <StatCard
              label="Current period"
              value={open ? open.label : '—'}
              hint={open ? `${n(open.records)} records` : 'Every period is closed'}
              tone={open ? 'success' : 'warning'}
            />
            <StatCard
              label="Open requests"
              value={n(totalOpenRequests)}
              hint="Across every period, at any stage"
              tone={totalOpenRequests > 0 ? 'warning' : 'default'}
              href="/admin/corrections"
            />
            <StatCard label="Periods on record" value={n(periods.length)} />
          </div>

          {/* Zero open periods is a real state — it happens after a manual close
              with no upload yet — and it silently blocks every new correction in
              the portal. Nothing else on any screen would explain why. */}
          {!open ? (
            <div className="mb-4">
              <Alert tone="warning" title="No period is open">
                Salespeople cannot raise new corrections against any record that belongs to a
                period. Commit the next month&apos;s workbook to open a new cycle, or reopen the
                most recent one below.
              </Alert>
            </div>
          ) : null}

          {/* The table stands on its own — it already draws a bordered, rounded
              panel, and wrapping it in a titleless Card drew that box twice with
              16px of dead space between the two rules. */}
          <div className="mb-4">
            <Table>
              <thead>
                <tr>
                  <Th>Period</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Records</Th>
                  <Th className="text-right">Batches</Th>
                  <Th className="text-right">Requests</Th>
                  <Th className="text-right">Still open</Th>
                  <Th>Closed</Th>
                  <Th>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <Td>
                      <span className="font-medium whitespace-nowrap text-slate-900">{p.label}</span>
                      <div className="mt-0.5 font-mono text-[11px] whitespace-nowrap text-slate-500">
                        {p.startsOn} → {p.endsOn}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={p.status === 'OPEN' ? 'success' : 'neutral'}>{p.status}</Badge>
                    </Td>
                    <Td className="text-right tabular-nums">{n(p.records)}</Td>
                    <Td className="text-right tabular-nums">{n(p.batches)}</Td>
                    <Td className="text-right tabular-nums">{n(p.requests)}</Td>
                    <Td className="text-right tabular-nums">
                      {p.openRequests > 0 ? (
                        <Badge tone="warning">{n(p.openRequests)}</Badge>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    <Td>
                      {p.closedAt ? (
                        <>
                          <span className="text-[12px] whitespace-nowrap text-slate-600">
                            {formatDateTime(p.closedAt)}
                          </span>
                          <div className="text-[11px] text-slate-500">{orDash(p.closedByName)}</div>
                        </>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    <Td>
                      <PeriodActions
                        periodId={p.id}
                        label={p.label}
                        status={p.status}
                        openRequests={p.openRequests}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </>
      )}

      <Card
        title="What closing a period does"
        description="Closing is narrow on purpose — it stops new claims and nothing else."
      >
        <ul className="space-y-2 text-[13px] leading-relaxed text-slate-600">
          <li>
            <strong className="text-slate-800">Blocked:</strong> raising a new correction request
            against a record that belongs to the closed period.
          </li>
          <li>
            <strong className="text-slate-800">Still allowed:</strong> verifying, approving,
            rejecting, returning, resubmitting and withdrawing requests that were already open;
            reading, filtering and exporting everything.
          </li>
          <li>
            A close never refuses because work is in flight. A close that one unreviewed request
            could veto would not happen, and the monthly upload would stall behind it.
          </li>
          <li>
            Records imported before periods existed carry no period, and are unaffected by any
            close.
          </li>
        </ul>
      </Card>
    </section>
  );
}
