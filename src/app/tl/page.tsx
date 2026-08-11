import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerDashboard } from '@/components/managers/manager-screens';

// requireRole here as well as in the layout: a page is reachable without the
// layout having decided anything, and a route that trusts its parent to have
// checked is one refactor away from being reachable without one.
export default async function TeamLeaderDashboardPage() {
  const user = await requireRoleOrRedirect('tl');
  return <ManagerDashboard user={user} role="tl" />;
}
