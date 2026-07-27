import { redirect } from 'next/navigation';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';

/**
 * The page-level session read for every /sales/requests screen.
 *
 * The layout already gates this route, so in practice the check passes — but a
 * session can expire or an account can be deactivated between the layout
 * rendering and the page rendering, and re-reading here means that window ends
 * in a redirect to the login screen rather than an unhandled AuthzError and a
 * 500. `redirect` signals by throwing, so it is only reachable from the catch.
 */
export async function requireSalesActor(): Promise<SessionUser> {
  try {
    return await requireRole('sales');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }
}
