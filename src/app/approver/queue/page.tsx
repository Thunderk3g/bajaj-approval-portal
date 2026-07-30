import { requireRole } from '@/lib/auth/rbac';
import { Card, PageHeader, Pagination, Select, Input, Button, StatCard } from '@/components/ui';
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
import { APPROVABLE_STATUS } from '@/lib/approvals/apply';

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
  await requireRole('approver');

  const params = await searchParams;
  const filters = parseQueueFilters(params);
  const page = parsePageParams(params);

  const [queue, counts] = await Promise.all([listQueue(filters, page), queueCounts()]);

  return (
    <>
      <PageHeader
        title="Approval queue"
        description="Verified requests only, oldest first. Approving applies the change to the record and writes a new version; returning sends the request back to the submitter without destroying its history."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <StatCard
          label="Awaiting decision"
          value={counts.awaitingDecision}
          hint="Verified and yours to decide"
          tone={counts.awaitingDecision > 0 ? 'warning' : 'default'}
          href="/approver/queue?scope=VERIFIED"
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

      <Card className="mb-4">
        <form method="get" className="grid gap-3 sm:grid-cols-4">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Scope</span>
            <Select name="scope" defaultValue={filters.scope}>
              {QUEUE_SCOPES.map((s) => (
                <option key={s} value={s}>
                  {QUEUE_SCOPE_LABELS[s]}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Category</span>
            <Select name="category" defaultValue={filters.category ?? ''}>
              <option value="">All categories</option>
              {CORRECTION_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Search</span>
            <Input
              name="q"
              defaultValue={filters.q ?? ''}
              placeholder="Apps_No, SM_ID, client or submitter"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Per page</span>
            <Select name="pageSize" defaultValue={String(page.pageSize)}>
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>

          <div className="sm:col-span-4">
            <Button type="submit" variant="secondary">
              Apply filters
            </Button>
          </div>
        </form>
      </Card>

      {/*
        Only the rows the approver may actually decide are offered for batching,
        and this map is what decides that — `QueueTable` renders a checkbox on
        exactly the same predicate. An empty map turns the bar off entirely,
        which is what the RETURNED and PENDING scopes get.
      */}
      <BulkDecisions
        stage="approver"
        appsNoById={Object.fromEntries(
          queue.rows.filter((r) => r.status === APPROVABLE_STATUS).map((r) => [r.id, r.appsNo]),
        )}
      >
        <QueueTable rows={queue.rows} selectable />
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
