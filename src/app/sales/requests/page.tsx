import type { Metadata } from 'next';
import Link from 'next/link';
import { CATEGORY_LABELS, type CorrectionCategory } from '@/lib/corrections/schemas';
import { listMyRequests } from '@/lib/corrections/queries';
import { requireSalesActor } from '@/lib/corrections/session';
import { formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import {
  Badge,
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

  const { rows, total } = await listMyRequests(actor, { offset, limit: pageSize, status });

  return (
    <section>
      <PageHeader
        title="My correction requests"
        description="Every correction you have raised, and where it has got to."
        actions={<LinkButton href="/sales/requests/new" variant="primary">New request</LinkButton>}
      />

      <nav aria-label="Filter by status" className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((filter) => {
          const active = (status ?? '') === filter.value;
          return (
            <Link
              key={filter.value || 'all'}
              href={`/sales/requests${buildQuery(params, { status: filter.value, page: undefined })}`}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-full border border-slate-900 bg-slate-900 px-3 py-1 text-xs font-medium text-white'
                  : 'rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50'
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
              .
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
                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <Td>
                      <Link
                        href={`/sales/requests/${row.id}`}
                        className="font-mono text-sm font-medium text-slate-900 underline-offset-2 hover:underline"
                      >
                        {row.appsNo}
                      </Link>
                    </Td>
                    <Td>{CATEGORY_LABELS[row.category as CorrectionCategory] ?? row.category}</Td>
                    <Td>
                      <span className="text-xs uppercase tracking-wide text-slate-500">
                        {row.fieldLabel}
                      </span>
                      <br />
                      <span className="text-slate-500">{orDash(row.originalValue)}</span>
                      <span className="px-1.5 text-slate-400" aria-hidden="true">
                        →
                      </span>
                      <span className="font-medium">{orDash(row.proposedValue)}</span>
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
    </section>
  );
}
