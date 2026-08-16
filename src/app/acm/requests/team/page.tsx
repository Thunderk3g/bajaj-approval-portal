import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { TeamRequestsScreen } from '@/components/managers/team-requests-screen';

export const metadata: Metadata = {
  title: 'Open in my teams · Sales Data Review Portal',
};

export default async function AreaManagerTeamRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRoleOrRedirect('acm');
  return <TeamRequestsScreen user={user} role="acm" params={await searchParams} />;
}
