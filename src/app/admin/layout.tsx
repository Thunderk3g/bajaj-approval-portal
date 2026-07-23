import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { AppShell } from '@/components/app-shell';

/**
 * This layout — not the middleware — is the authorization boundary for /admin.
 *
 * redirect() signals by throwing, so it is only ever called from the catch
 * branch for an AuthzError and anything else is re-thrown. Calling it inside
 * the try, or swallowing unknown errors here, would turn a redirect into a
 * silently rendered page.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  let user: SessionUser;

  try {
    user = await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  return <AppShell user={user}>{children}</AppShell>;
}
