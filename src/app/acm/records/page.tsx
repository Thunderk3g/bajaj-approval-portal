import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerRecords } from '@/components/records/manager-records';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: "My cluster's records · Sales Data Review Portal",
};

export default async function AreaManagerRecordsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireRoleOrRedirect('acm');
  return <ManagerRecords user={user} role="acm" params={await searchParams} />;
}
