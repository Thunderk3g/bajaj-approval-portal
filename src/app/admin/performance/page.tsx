import type { Metadata } from 'next';
import { PerformanceScreen } from '@/components/charts/performance-view';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'Performance · Sales Data Review Portal',
};

export default async function AdminPerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('admin');

  return (
    <PerformanceScreen
      viewer={viewer}
      params={await searchParams}
      basePath="/admin/performance"
      rungs={['sm', 'tl', 'acm']}
      // The rep and team-leader rungs drill in; the area-manager rung has no
      // matching record filter, so those rows stay plain text.
      recordsBasePath="/admin/records"
      title="Performance"
      description="Issuance, refusal and share of logins, across everything imported. Switch the rung to read the same figures by rep, by team leader or by area manager."
      totalsLabel="Every record imported"
      emptyTitle="No records in this period"
      emptyDescription="Commit a business dashboard for this month and every figure on this page fills in. If a month is already committed, widen the period filter to All periods."
    />
  );
}
