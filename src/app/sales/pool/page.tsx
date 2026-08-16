import type { Metadata } from 'next';
import { PoolScreen } from '@/components/records/pool-screen';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import type { SearchParams } from '@/lib/records/pool';

export const metadata: Metadata = {
  title: 'Unassigned pool · Sales Data Review Portal',
};

export default async function SalesPoolPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The layout already checked, but the layout is not the boundary (spec
  // section 4.1): this page re-reads the session and role itself, so a directly
  // fetched route or a session revoked mid-request still fails closed.
  const viewer = await requireRoleOrRedirect('sales');
  return <PoolScreen viewer={viewer} role="sales" searchParams={await searchParams} />;
}
