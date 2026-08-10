import { requireRole } from '@/lib/auth/rbac';
import { ManagerQueue } from '@/components/managers/manager-screens';

export default async function TeamLeaderQueuePage() {
  const user = await requireRole('tl');
  return <ManagerQueue user={user} role="tl" />;
}
