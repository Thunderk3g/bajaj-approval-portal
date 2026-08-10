import { requireRole } from '@/lib/auth/rbac';
import { ManagerTeam } from '@/components/managers/manager-screens';

export default async function AreaManagerTeamPage() {
  const user = await requireRole('acm');
  return <ManagerTeam user={user} role="acm" />;
}
