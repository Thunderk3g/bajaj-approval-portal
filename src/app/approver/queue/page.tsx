import { requireRoleOrRedirect } from '@/lib/auth/page';
import { PageHeader, Pagination, Select, Input, Button, StatCard } from '@/components/ui';
import { FilterBar, FilterField } from '@/components/approvals/filter-bar';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import { listQueue, queueCounts } from '@/lib/approvals/queries';
import {
  CATEGORY_LABELS,
  CORRECTION_CATEGORIES,
  QUEUE_SCOPES,
  QUEUE_SCOPE_LABELS,
  parseQueueFilters,
  type SearchParams,
} from '@/lib/approvals/schemas';
import { QueueTable } from '@/components/approvals/queue-table';
import { BulkDecisions } from '@/components/approvals/bulk-decisions';

export const dynamic = 'force-dynamic';

/**
 * The pending queue — spec section 9.
 *
 * `requireRole` runs here as well as in the layout. The layout gate is what
 * redirects a browser, but this page is also the target of a direct fetch, and
 * spec 4.1 puts the boundary on the data access rather than on the shell around
 * it.
 */
export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('approver');

  const params = await searchParams;
  const filters = parseQueueFilters(params);
  const page = parsePageParams(params);

  const [queue, counts] = await Promise.all([
    listQueue(filters, page, viewer),
    queueCounts(viewer),
  ]);

  return (
    <>
      <PageHeader
        title="Approval queue"
        description="Verified requests only, oldest first. Approving applies the change to the record and writes a new version; returning sends the request back to the submitter without destroying its history."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Awaiting decision"
          value={counts.awaitingDecision}
          hint="At your step, and yours to decide"
          tone={counts.awaitingDecision > 0 ? 'warning' : 'default'}
          href="/approver/queue?scope=MINE"
        />
        <StatCard
          label="Oldest waiting"
          value={`${counts.oldestDays}d`}
          hint="Days since the rep submitted it"
          tone={counts.oldestDays >= 7 ? 'danger' : 'default'}
        />
        {/* Upstream of this queue. An approver whose own list is empty while
            this number climbs is blocked, not idle, and nothing else on the
            page distinguishes the two. */}
        <StatCard
          label="Awaiting verification"
          value={counts.awaitingVerification}
          hint="With a verifier — not yours yet"
          href="/approver/queue?scope=PENDING"
        />
        <StatCard
          label="Returned"
          value={counts.returned}
          hint="Waiting on the submitter, not on you"
          href="/approver/queue?scope=RETURNED"
        />
      </div>

      <FilterBar className="mb-3">
        <FilterField label="Scope">
          <Select name="scope" defaultValue={filters.scope}>
            {QUEUE_SCOPES.map((s) => (
              <option key={s} value={s}>
                {QUEUE_SCOPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Category">
          <Select name="category" defaultValue={filters.category ?? ''}>
            <option value="">All categories</option>
            {CORRECTION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Search">
          <Input
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="Apps_No, SM_ID, client or submitter"
          />
        </FilterField>

        <FilterField label="Per page">
          <Select name="pageSize" defaultValue={String(page.pageSize)}>
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </FilterField>

        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </FilterBar>

      {/*
        Only the rows the approver may actually decide are offered for batching,
        and this map is what decides that — `QueueTable` renders a checkbox on
        exactly the same predicate. An empty map turns the bar off entirely,
        which is what the RETURNED and PENDING scopes get.
      */}
      <BulkDecisions
        stage="approver"
        // Every row of the MINE scope is by definition at this approver's own
        // step, and no row of any other scope is. Selecting on the row's status
        // was the old proxy for that, and it stopped being true once VERIFIED
        // could also mean "parked with a manager two rungs below me".
        appsNoById={
          filters.scope === 'MINE'
            ? Object.fromEntries(queue.rows.map((r) => [r.id, r.appsNo]))
            : {}
        }
      >
        <QueueTable rows={queue.rows} selectable decidable={filters.scope === 'MINE'} />
      </BulkDecisions>

      <Pagination
        page={queue.page}
        pageCount={queue.pageCount}
        totalRows={queue.total}
        hrefFor={(p) => `/approver/queue${buildQuery(params, { page: p })}`}
      />
    </>
  );
}
