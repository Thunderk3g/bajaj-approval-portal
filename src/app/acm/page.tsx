import { requireRole } from '@/lib/auth/rbac';
import { ManagerDashboard } from '@/components/managers/manager-screens';

export default async function AreaManagerDashboardPage() {
  const user = await requireRole('acm');
  return <ManagerDashboard user={user} role="acm" />;
}
