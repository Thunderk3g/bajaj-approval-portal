import { requireRole } from '@/lib/auth/rbac';
import { ManagerQueue } from '@/components/managers/manager-screens';

export default async function AreaManagerQueuePage() {
  const user = await requireRole('acm');
  return <ManagerQueue user={user} role="acm" />;
}
