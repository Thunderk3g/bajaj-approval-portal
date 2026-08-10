import { redirect } from 'next/navigation';
import { requireRole, type Role, type SessionUser } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';

/**
 * `requireRole` for a PAGE: a refusal becomes a redirect, never an error screen.
 *
 * A layout and the page inside it render in parallel. /admin/layout.tsx already
 * redirects a non-admin, but that redirect does not pre-empt the page's own
 * check — so a page that lets `AuthzError` escape answers with a digest and a
 * crash screen while the layout is busy sending the same visitor to /login. That
 * is what `/admin/workflows` did, and twenty other routes were one visit away
 * from doing it too.
 *
 * The per-page check itself stays (spec section 4.1): a route that trusts its
 * parent to have checked is one refactor away from being reachable without one.
 * Only the failure path is shared, so every page fails the same way.
 *
 * Pages only. `redirect()` signals by throwing a control-flow error that Next
 * unwinds against the current render — a Server Action or an API route wants the
 * `AuthzError` itself, which is why `requireRole` remains the export those use.
 */
export async function requireRoleOrRedirect(...roles: Role[]): Promise<SessionUser> {
  try {
    return await requireRole(...roles);
  } catch (error) {
    if (error instanceof AuthzError) {
      // FORBIDDEN means signed in as the wrong role — saying so beats bouncing
      // them to a sign-in form they are already past. Anything else (no session,
      // deactivated account) is answered by signing in again.
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }
}
