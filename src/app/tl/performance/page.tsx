import type { Metadata } from 'next';
import { PerformanceScreen } from '@/components/charts/performance-view';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'Team performance · Sales Data Review Portal',
};

export default async function TeamLeaderPerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('tl');

  return (
    <PerformanceScreen
      viewer={viewer}
      params={await searchParams}
      basePath="/tl/performance"
      // One rung. A team leader has exactly one team, so grouping their own
      // records by team leader would be a table with a single row.
      rungs={['sm']}
      rungTabs={{ sm: 'My reps' }}
      title="Team performance"
      description="Every rep on your team, and your team's own total. Issuance is issued over logins; login share is that rep's share of the team's logins, so the column adds to 100%."
      totalsLabel="My team"
      emptyTitle="No records for your team in this period"
      emptyDescription="Your reps' policies appear here once an administrator commits a business dashboard covering this month. If the roster has just changed, a rep moved onto your team brings their records with them."
    />
  );
}
