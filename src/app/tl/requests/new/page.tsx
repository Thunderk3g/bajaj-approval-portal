import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerNewRequest } from '@/components/managers/manager-new-request';
import type { MappingDirection } from '@/lib/corrections/schemas';

export const metadata: Metadata = {
  title: 'New correction request · Sales Data Review Portal',
};

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function TeamLeaderNewRequestPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireRoleOrRedirect('tl');
  const params = await searchParams;

  return (
    <ManagerNewRequest
      user={user}
      role="tl"
      initialAppsNo={first(params.appsNo)}
      initialCategory={first(params.category).toUpperCase()}
      initialDirection={first(params.direction).toUpperCase() as MappingDirection}
    />
  );
}
