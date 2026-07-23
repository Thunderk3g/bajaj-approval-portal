import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/rbac';
import { dashboardPathForRole, safeNextPath } from '@/lib/auth/redirects';
import { LoginForm } from '@/components/login-form';

export const metadata: Metadata = {
  title: 'Sign in · Sales Data Review Portal',
};

// Next 15: searchParams is a Promise in server components and must be awaited.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const params = await searchParams;
  const rawNext = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeNextPath(rawNext);

  const user = await getSession();
  if (user && user.isActive) {
    redirect(next ?? dashboardPathForRole(user.role));
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            Sales Data Review Portal
          </h1>
          <p className="mt-1 text-sm text-slate-500">Bajaj Life — internal use only</p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <LoginForm next={next} />
        </div>

        <p className="mt-6 text-xs text-slate-500">
          Activity in this portal is recorded. Sign in only with your own account.
        </p>
      </div>
    </main>
  );
}
