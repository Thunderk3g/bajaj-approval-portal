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
      // The drill-down the report was missing: a team leader's row links to that
      // team's policies, a rep's row to that rep's. The filter is ANDed with this
      // account's own cluster scope, so the link narrows and never widens.
      recordsBasePath="/acm/records"
      title="Cluster performance"
      description="Your team leaders side by side, expandable to every rep beneath them, and where your cluster sits against the others. An application the sheet marks issued but whose Status 2 says APPROVED counts as pending, and one cancelled in the free-look window counts as rejected."
      totalsLabel="My cluster"
      emptyTitle="No records in your cluster for this period"
      emptyDescription="Your teams' policies appear here once an administrator commits a business dashboard covering this month. A rep placed under no team leader still counts towards your total and is listed as unplaced."
    />
  );
}
