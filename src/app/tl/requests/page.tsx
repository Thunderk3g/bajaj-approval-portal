import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerRequests } from '@/components/managers/manager-screens';

export const metadata: Metadata = {
  title: 'Requests I raised · Sales Data Review Portal',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function TeamLeaderRequestsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireRoleOrRedirect('tl');
  return <ManagerRequests user={user} role="tl" params={await searchParams} />;
}
