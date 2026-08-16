import type { Metadata } from 'next';
import { PoolScreen } from '@/components/records/pool-screen';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/pool';

export const metadata: Metadata = {
  title: 'Unassigned pool · Sales Data Review Portal',
};

export default async function AreaManagerPoolPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('acm');
  return <PoolScreen viewer={viewer} role="acm" searchParams={await searchParams} />;
}
