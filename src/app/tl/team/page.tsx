import { requireRole } from '@/lib/auth/rbac';
import { ManagerTeam } from '@/components/managers/manager-screens';

export default async function TeamLeaderTeamPage() {
  const user = await requireRole('tl');
  return <ManagerTeam user={user} role="tl" />;
}
