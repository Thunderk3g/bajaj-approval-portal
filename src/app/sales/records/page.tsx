import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader, Pagination, StatCard } from '@/components/ui';
import { RecordFilterBar } from '@/components/records/record-filters';
import { RecordTable } from '@/components/records/record-table';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import {
  EMPTY_FILTERS,
  filterFormValues,
  parseRecordFilters,
  type SearchParams,
} from '@/lib/records/filters';
import { countRecords, listBatchOptions, listRecords, listStatusOptions } from '@/lib/records/query';

export const metadata: Metadata = {
  title: 'My records · Sales Data Review Portal',
};

export default async function SalesRecordsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  let viewer: SessionUser;
  try {
    viewer = await requireRole('sales');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const params = await searchParams;
  const filters = parseRecordFilters(params, viewer);
  const page = parsePageParams(params);

  // No sm_id is read from `params` anywhere on this page. Scoping comes from
  // the session through scopedRecordCondition, so a hand-edited ?smId= reaches
  // the query as nothing at all — section 4.1.
  const [{ rows, total }, gapTotal, statusOptions, batchOptions] = await Promise.all([
    listRecords(viewer, filters, page),
    countRecords(viewer, { ...EMPTY_FILTERS, gap: 'ANY' }),
    listStatusOptions(viewer),
    listBatchOptions(viewer),
  ]);

  return (
    <section className="space-y-4">
      <PageHeader
        title="My records"
        description="Applications credited to your SM_ID. The Missing column is your worklist — a median rep has six of these and nobody has more than thirty, so it fits one page."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard label="Records in your book" value={total.toLocaleString('en-IN')} />
        <StatCard
          label="Rows with a gap"
          value={gapTotal.toLocaleString('en-IN')}
          tone={gapTotal > 0 ? 'warning' : 'success'}
          hint="ISSUED applications missing AutoPay, an issuance date, or a policy number"
          href="/sales/records?gap=ANY"
        />
      </div>

      <RecordFilterBar
        basePath="/sales/records"
        values={filterFormValues(filters)}
        pageSize={page.pageSize}
        showSmId={false}
        smIdOptions={[]}
        statusOptions={statusOptions}
        batchOptions={batchOptions}
      />

      <RecordTable
        rows={rows}
        basePath="/sales/records"
        detailBase="/sales/records"
        query={params}
        sort={filters.sort}
        dir={filters.dir}
        variant="sales"
      />

      <Pagination
        page={page.page}
        pageCount={pageCount(total, page.pageSize)}
        totalRows={total}
        hrefFor={(next) => `/sales/records${buildQuery(params, { page: next })}`}
      />
    </section>
  );
}
