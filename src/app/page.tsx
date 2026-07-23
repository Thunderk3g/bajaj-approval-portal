import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/rbac';
import { dashboardPathForRole } from '@/lib/auth/redirects';

/**
 * The root is a router, not a page: it sends each signed-in user to their own
 * dashboard and everyone else to the login screen. A deactivated account is
 * treated as signed out, so a disabled user cannot sit on a stale session and
 * keep reaching role pages from the root.
 */
export default async function RootPage() {
  const user = await getSession();

  if (!user || !user.isActive) {
    redirect('/login');
  }

  redirect(dashboardPathForRole(user.role));
}
