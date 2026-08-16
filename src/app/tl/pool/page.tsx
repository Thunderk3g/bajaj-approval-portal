import type { Metadata } from 'next';
import { PoolScreen } from '@/components/records/pool-screen';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/pool';

export const metadata: Metadata = {
  title: 'Unassigned pool · Sales Data Review Portal',
};

export default async function TeamLeaderPoolPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('tl');
  return <PoolScreen viewer={viewer} role="tl" searchParams={await searchParams} />;
}
