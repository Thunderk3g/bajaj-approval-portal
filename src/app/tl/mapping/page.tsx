import type { Metadata } from 'next';
import { MappingScreen } from '@/components/charts/mapping-screen';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'Book mapping · Sales Data Review Portal',
};

export default async function TeamLeaderMappingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('tl');

  return (
    <MappingScreen
      viewer={viewer}
      params={await searchParams}
      title="Book mapping"
      description="Your team's policies laid over the roster — who sold how much, and how the team's book divides between your reps."
    />
  );
}
