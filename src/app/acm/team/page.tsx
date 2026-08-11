import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerTeam } from '@/components/managers/manager-screens';

export default async function AreaManagerTeamPage() {
  const user = await requireRoleOrRedirect('acm');
  return <ManagerTeam user={user} role="acm" />;
}
