import { requireRole } from '@/lib/auth/rbac';
import { Button, Card, Input, PageHeader, Pagination, Select } from '@/components/ui';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import { listHistory } from '@/lib/approvals/queries';
import {
  CATEGORY_LABELS,
  CORRECTION_CATEGORIES,
  HISTORY_ACTIONS,
  parseHistoryFilters,
  type SearchParams,
} from '@/lib/approvals/schemas';
import { HistoryTable } from '@/components/approvals/queue-table';

export const dynamic = 'force-dynamic';

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const approver = await requireRole('approver');

  const params = await searchParams;
  const filters = parseHistoryFilters(params);
  const page = parsePageParams(params);

  const history = await listHistory(filters, page, approver.id);

  return (
    <>
      <PageHeader
        title="Decision history"
        description="Every approval, rejection and return — including returns that were later resubmitted, which the request's own status no longer remembers."
      />

      <Card className="mb-4">
        <form method="get" className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Decision</span>
            <Select name="action" defaultValue={filters.action ?? ''}>
              <option value="">All decisions</option>
              {HISTORY_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
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
            <span className="mb-1 block font-medium text-slate-700">From</span>
            <Input type="date" name="from" defaultValue={filters.from ?? ''} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">To</span>
            <Input type="date" name="to" defaultValue={filters.to ?? ''} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Search</span>
            <Input name="q" defaultValue={filters.q ?? ''} placeholder="Apps_No or SM_ID" />
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

          <div className="flex items-center gap-3 sm:col-span-3 lg:col-span-6">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="mine"
                value="1"
                defaultChecked={filters.mine}
                className="h-4 w-4 rounded border-slate-300"
              />
              Only my decisions
            </label>
            <Button type="submit" variant="secondary">
              Apply filters
            </Button>
          </div>
        </form>
      </Card>

      <HistoryTable rows={history.rows} />

      <Pagination
        page={history.page}
        pageCount={history.pageCount}
        totalRows={history.total}
        hrefFor={(p) => `/approver/history${buildQuery(params, { page: p })}`}
      />
    </>
  );
}
