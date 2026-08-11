import type { Metadata } from 'next';
import { MappingScreen } from '@/components/charts/mapping-screen';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'Book mapping · Sales Data Review Portal',
};

export default async function AreaManagerMappingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('acm');

  return (
    <MappingScreen
      viewer={viewer}
      params={await searchParams}
      title="Book mapping"
      description="Every team in your cluster with the policies that landed on it, expandable to the reps beneath each team leader."
    />
  );
}
