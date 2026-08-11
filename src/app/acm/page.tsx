import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerDashboard } from '@/components/managers/manager-screens';

export default async function AreaManagerDashboardPage() {
  const user = await requireRoleOrRedirect('acm');
  return <ManagerDashboard user={user} role="acm" />;
}
