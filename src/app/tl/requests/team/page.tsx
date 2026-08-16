import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { TeamRequestsScreen } from '@/components/managers/team-requests-screen';

export const metadata: Metadata = {
  title: 'Open in my team · Sales Data Review Portal',
};

/**
 * A static segment under the same folder as `[id]`, deliberately.
 *
 * Next resolves `team` to this route before it considers the dynamic one, so the
 * screen lives beside the request detail it links to and the manager's mental
 * model — "requests, mine and my team's" — survives in the URL.
 */
export default async function TeamLeaderTeamRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireRoleOrRedirect('tl');
  return <TeamRequestsScreen user={user} role="tl" params={await searchParams} />;
}
