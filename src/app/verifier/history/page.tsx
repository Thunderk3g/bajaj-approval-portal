import { requireRoleOrRedirect } from '@/lib/auth/page';
import { Button, Input, PageHeader, Pagination, Select } from '@/components/ui';
import { FilterBar, FilterField } from '@/components/approvals/filter-bar';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import { listVerifierHistory } from '@/lib/verification/queries';
import { CATEGORY_LABELS, CORRECTION_CATEGORIES, type SearchParams } from '@/lib/approvals/schemas';
import {
  VERIFIER_HISTORY_ACTIONS,
  parseVerifierHistoryFilters,
} from '@/lib/verification/schemas';
import { HistoryTable } from '@/components/approvals/queue-table';

export const dynamic = 'force-dynamic';

export default async function VerifierHistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const verifier = await requireRoleOrRedirect('verifier');

  const params = await searchParams;
  const filters = parseVerifierHistoryFilters(params);
  const page = parsePageParams(params);

  const history = await listVerifierHistory(filters, page, verifier.id);

  return (
    <>
      <PageHeader
        title="Verification history"
        description="Every request this team verified or returned — including returns that were later resubmitted, which the request's own status no longer remembers. Approver decisions are not listed here."
      />

      <FilterBar className="mb-3">
        <FilterField label="Outcome">
          <Select name="action" defaultValue={filters.action ?? ''}>
            <option value="">All outcomes</option>
            {VERIFIER_HISTORY_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
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

        <FilterField label="From">
          <Input type="date" name="from" defaultValue={filters.from ?? ''} />
        </FilterField>

        <FilterField label="To">
          <Input type="date" name="to" defaultValue={filters.to ?? ''} />
        </FilterField>

        <FilterField label="Search">
          <Input name="q" defaultValue={filters.q ?? ''} placeholder="Apps_No or SM_ID" />
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

        <label className="flex h-[30px] items-center gap-2 text-[12px] text-slate-700">
          <input
            type="checkbox"
            name="mine"
            value="1"
            defaultChecked={filters.mine}
            className="size-4 rounded border-slate-300 accent-slate-900"
          />
          Only mine
        </label>

        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </FilterBar>

      <HistoryTable rows={history.rows} basePath="/verifier" actorLabel="Verifier" />

      <Pagination
        page={history.page}
        pageCount={history.pageCount}
        totalRows={history.total}
        hrefFor={(p) => `/verifier/history${buildQuery(params, { page: p })}`}
      />
    </>
  );
}
