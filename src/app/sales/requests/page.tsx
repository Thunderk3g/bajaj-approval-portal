import type { Metadata } from 'next';
import Link from 'next/link';
import { CATEGORY_LABELS, type CorrectionCategory } from '@/lib/corrections/schemas';
import { listCounterpartyRequests, listMyRequests } from '@/lib/corrections/queries';
import { requireSalesActor } from '@/lib/corrections/session';
import { formatDate, formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Pagination,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';

export const metadata: Metadata = {
  title: 'My requests · Sales Data Review Portal',
};

/**
 * Every status a rep's own request can be in, phrased from the rep's side.
 *
 * The labels say where the request IS, not what its enum is called: a rep does
 * not need to know the stage is named VERIFIED, they need to know it is now with
 * an approver. `src/app/sales/page.tsx` uses the same phrasing on its dashboard
 * tiles, and those tiles link here.
 *
 * VERIFIED and WITHDRAWN were missing, and the consequence was worse than an
 * absent pill. An unrecognised `status` falls through to `undefined` below,
 * which means "All" — so the two dashboard tiles linking to `?status=VERIFIED`
 * and `?status=WITHDRAWN` silently landed the rep on an unfiltered list with the
 * "All" pill highlighted. The filter did not fail; it quietly answered a
 * different question.
 */
const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'With a verifier' },
  { value: 'VERIFIED', label: 'With an approver' },
  { value: 'RETURNED', label: 'Returned' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Closed' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
] as const;

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MyRequestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const actor = await requireSalesActor();
  const params = await searchParams;

  const { page, pageSize, offset } = parsePageParams(params);
  const statusParam = typeof params.status === 'string' ? params.status : '';
  const status = STATUS_FILTERS.some((f) => f.value === statusParam && f.value !== '')
    ? statusParam
    : undefined;

  // Independent reads, so they overlap. The counterparty list is not paginated
  // and not filtered by the status pills above — it answers a different question
  // from the one this page's controls ask, and awaiting it after the main query
  // would put a second serial round trip in front of every filter click.
  const [{ rows, total }, counterparty] = await Promise.all([
    listMyRequests(actor, { offset, limit: pageSize, status }),
    listCounterpartyRequests(actor),
  ]);

  return (
    <section>
      <PageHeader
        title="My correction requests"
        description="Every correction on your book — the ones you raised and the ones your team leader or area manager raised for you — and where each has got to."
        actions={<LinkButton href="/sales/requests/new" variant="primary">New request</LinkButton>}
      />

      {/* Square chips, not capsules. A fully rounded pill beside a table reads as
          a button somebody can press rather than as the filter it is — the same
          rule the shared Badge follows. */}
      <nav aria-label="Filter by status" className="mb-3 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((filter) => {
          const active = (status ?? '') === filter.value;
          return (
            <Link
              key={filter.value || 'all'}
              href={`/sales/requests${buildQuery(params, { status: filter.value, page: undefined })}`}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-md border border-slate-900 bg-slate-900 px-2.5 py-1 text-[12px] font-medium text-white'
                  : 'rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50'
              }
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title="No correction requests yet."
          description={
            <>
              Raise one from a record that is missing a field, or{' '}
              <Link href="/sales/requests/new" className="underline">
                start a new request
              </Link>
              . Anything your team leader or area manager raises against your book appears here too.
            </>
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Application</Th>
                <Th>Category</Th>
                <Th>Change</Th>
                <Th>Status</Th>
                <Th>Activity</Th>
                <Th>Proof</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const shown = row.status;
                // Who raised it decides what this rep can DO with it, so it is
                // stated on the row rather than left to be discovered on the
                // detail screen when the resubmit form turns out not to be there.
                const mine = row.submittedBy === actor.id;
                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <Td>
                      <Link
                        href={`/sales/requests/${row.id}`}
                        className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                      >
                        {row.appsNo}
                      </Link>
                      {mine ? null : (
                        <div className="mt-1">
                          <Badge tone="info">Raised by {row.submitterName ?? 'your manager'}</Badge>
                        </div>
                      )}
                    </Td>
                    <Td>{CATEGORY_LABELS[row.category as CorrectionCategory] ?? row.category}</Td>
                    <Td>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
                        {row.fieldLabel}
                      </div>
                      <div className="mt-0.5">
                        <span className="font-mono text-xs text-slate-500">
                          {orDash(row.originalValue)}
                        </span>
                        <span className="px-1 text-slate-400" aria-hidden="true">
                          →
                        </span>
                        <span className="font-mono text-xs font-medium text-slate-900">
                          {orDash(row.proposedValue)}
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <StatusBadge status={shown} />
                      {row.resubmissionCount > 0 ? (
                        <span className="ml-1.5 text-xs text-slate-500">
                          resubmitted {row.resubmissionCount}×
                        </span>
                      ) : null}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-600">
                      {formatDateTime(row.lastEventAt ?? row.submittedAt)}
                      {row.approverRemarks ? (
                        <p className="mt-0.5 max-w-xs truncate text-slate-500" title={row.approverRemarks}>
                          {row.approverRemarks}
                        </p>
                      ) : null}
                    </Td>
                    <Td>
                      <Badge tone={row.attachmentCount > 0 ? 'neutral' : 'warning'}>
                        {row.attachmentCount}
                      </Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>

          <Pagination
            page={page}
            pageCount={pageCount(total, pageSize)}
            totalRows={total}
            hrefFor={(next) => `/sales/requests${buildQuery(params, { page: next })}`}
          />
        </>
      )}

      {/* Open mapping requests where this rep is the OTHER party — 2026-07-29
          spec section 5.

          Until this existed a rep learned that a sale was leaving their book
          only once it had gone: MAPPING_LOST / MAPPING_GAINED fire at approval,
          a full review cycle past the point where saying something could still
          change the outcome. This is the same facts while the request is still
          in the queue.

          Nothing renders at all when the list is empty, rather than an empty
          state. Being party to someone else's reassignment is rare, and a
          standing "no cross-book activity" card would charge every rep who
          reads this page daily a block of chrome to be told nothing. */}
      {counterparty.length > 0 ? (
        <Card
          className="mt-6"
          title="Involving my book"
          description="The verifier and the approver decide these — nothing here needs an action from you. Raise your own request if you disagree."
        >
          <Table>
            <thead>
              <tr>
                <Th>Application</Th>
                <Th>Policy</Th>
                <Th>Client</Th>
                <Th>What happens</Th>
                <Th>Status</Th>
                <Th>Raised</Th>
              </tr>
            </thead>
            <tbody>
              {counterparty.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <Td>
                    <span className="font-mono font-medium text-slate-900">{row.appsNo}</span>
                    <div className="mt-0.5 text-xs text-slate-500">
                      issued {formatDate(row.issuedDate)}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{orDash(row.policyNo)}</Td>
                  <Td>
                    {orDash(row.clientName)}
                    <div className="mt-0.5 text-xs text-slate-500">{orDash(row.productName)}</div>
                  </Td>
                  {/* Phrased off `role`, not `direction`: direction says who asked,
                      and a rep reading this wants to know what becomes of their
                      own book. The second line is the one place direction is worth
                      spending a sentence on. */}
                  <Td>
                    <Badge tone={row.role === 'LOSING' ? 'warning' : 'info'}>
                      {row.role === 'LOSING' ? 'Leaving my book' : 'Coming to my book'}
                    </Badge>
                    <p className="mt-1">
                      {row.role === 'LOSING' ? (
                        <>
                          Would move to <span className="font-mono">{row.proposedSmId}</span>
                        </>
                      ) : (
                        <>
                          Would move to you from{' '}
                          <span className="font-mono">{row.currentSmId}</span>
                        </>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {row.direction === 'CLAIM_IN'
                        ? 'The other rep is claiming it.'
                        : 'The other rep is sending it.'}
                    </p>
                  </Td>
                  <Td>
                    <StatusBadge status={row.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-600">
                    {formatDateTime(row.submittedAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}
    </section>
  );
}
