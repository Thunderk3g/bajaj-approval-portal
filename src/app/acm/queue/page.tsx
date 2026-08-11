import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerQueue } from '@/components/managers/manager-screens';

export default async function AreaManagerQueuePage() {
  const user = await requireRoleOrRedirect('acm');
  return <ManagerQueue user={user} role="acm" />;
}
