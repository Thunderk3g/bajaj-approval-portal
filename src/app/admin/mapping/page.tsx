import type { Metadata } from 'next';
import { MappingScreen } from '@/components/charts/mapping-screen';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'Book mapping · Sales Data Review Portal',
};

export default async function AdminMappingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('admin');

  return (
    <MappingScreen
      viewer={viewer}
      params={await searchParams}
      batchFilter
      title="Book mapping"
      description="Every policy laid over the Manpower hierarchy. What this screen is for is the bucket at the bottom: codes carrying real business that no team leader or area manager can be asked about."
    />
  );
}
