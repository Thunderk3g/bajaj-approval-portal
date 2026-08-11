import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerRecords } from '@/components/records/manager-records';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: "My team's records · Sales Data Review Portal",
};

export default async function TeamLeaderRecordsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireRoleOrRedirect('tl');
  return <ManagerRecords user={user} role="tl" params={await searchParams} />;
}
