import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PageHeader, Pagination } from '@/components/ui';
import { RecordFilterBar } from '@/components/records/record-filters';
import { RecordTable } from '@/components/records/record-table';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import {
  filterFormValues,
  parseRecordFilters,
  type SearchParams,
} from '@/lib/records/filters';
import {
  listBatchOptions,
  listRecords,
  listSmIdOptions,
  listStatusOptions,
} from '@/lib/records/query';

export const metadata: Metadata = {
  title: 'Records · Sales Data Review Portal',
};

export default async function AdminRecordsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The layout already checked, but the layout is not the boundary (section
  // 4.1): this page re-reads the session and role itself so a directly rendered
  // route or a session revoked mid-request still fails closed.
  let viewer: SessionUser;
  try {
    viewer = await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const params = await searchParams;
  const filters = parseRecordFilters(params, viewer);
  const page = parsePageParams(params);

  const [{ rows, total }, statusOptions, batchOptions, smIdOptions] = await Promise.all([
    listRecords(viewer, filters, page),
    listStatusOptions(viewer),
    listBatchOptions(viewer),
    listSmIdOptions(viewer),
  ]);

  return (
    <section className="space-y-4">
      <PageHeader
        title="Records"
        description="Every imported application. Gap flags follow the status-conditional rule of section 6.4, so a blank on a PENDING row is not counted as work."
      />

      <RecordFilterBar
        basePath="/admin/records"
        values={filterFormValues(filters)}
        pageSize={page.pageSize}
        showSmId
        smIdOptions={smIdOptions}
        statusOptions={statusOptions}
        batchOptions={batchOptions}
      />

      <RecordTable
        rows={rows}
        basePath="/admin/records"
        detailBase="/admin/records"
        query={params}
        sort={filters.sort}
        dir={filters.dir}
        variant="admin"
      />

      <Pagination
        page={page.page}
        pageCount={pageCount(total, page.pageSize)}
        totalRows={total}
        hrefFor={(next) => `/admin/records${buildQuery(params, { page: next })}`}
      />
    </section>
  );
}
