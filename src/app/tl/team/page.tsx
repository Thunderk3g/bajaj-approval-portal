import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerTeam } from '@/components/managers/manager-screens';

export default async function TeamLeaderTeamPage() {
  const user = await requireRoleOrRedirect('tl');
  return <ManagerTeam user={user} role="tl" />;
}
