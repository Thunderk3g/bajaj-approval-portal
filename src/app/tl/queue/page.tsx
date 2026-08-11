import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerQueue } from '@/components/managers/manager-screens';

export default async function TeamLeaderQueuePage() {
  const user = await requireRoleOrRedirect('tl');
  return <ManagerQueue user={user} role="tl" />;
}
