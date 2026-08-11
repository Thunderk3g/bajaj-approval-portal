import type { Metadata } from 'next';
import { PerformanceScreen } from '@/components/charts/performance-view';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'Cluster performance · Sales Data Review Portal',
};

export default async function AreaManagerPerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('acm');

  return (
    <PerformanceScreen
      viewer={viewer}
      params={await searchParams}
      basePath="/acm/performance"
      // Team leaders first, because that is the comparison an area manager
      // came for; the rep rung is the same records expanded one level down.
      rungs={['tl', 'sm']}
      rungTabs={{ tl: 'My team leaders', sm: 'Every rep' }}
      title="Cluster performance"
      description="Your team leaders side by side, expandable to every rep beneath them. Login share is each row's share of your cluster's logins, not of the company's."
      totalsLabel="My cluster"
      emptyTitle="No records in your cluster for this period"
      emptyDescription="Your teams' policies appear here once an administrator commits a business dashboard covering this month. A rep placed under no team leader still counts towards your total and is listed as unplaced."
    />
  );
}
