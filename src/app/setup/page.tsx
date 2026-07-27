import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MIN_PASSWORD_LENGTH, countUsers } from './first-admin';
import { SetupForm } from './setup-form';

export const metadata: Metadata = {
  title: 'First-run setup · Sales Data Review Portal',
  robots: { index: false, follow: false },
};

/**
 * Whether this route exists depends on a table's contents, which changes once
 * and never changes back. Prerendering it would bake in the answer from build
 * time — an empty database — and serve the account-creation form to the world
 * for the life of the deployment.
 */
export const dynamic = 'force-dynamic';

/**
 * Public, first-run only — spec sections 9 and 4.2.
 *
 * This is the one page in the application with no session check, so its
 * existence is the access control: once any account exists the route is a 404,
 * and the Server Action behind the form re-checks under a lock rather than
 * trusting this render.
 */
export default async function SetupPage() {
  if ((await countUsers()) > 0) notFound();

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            Sales Data Review Portal
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            First-run setup — create the administrator account.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <SetupForm minPasswordLength={MIN_PASSWORD_LENGTH} />
        </div>

        <p className="mt-6 text-xs text-slate-500">
          This page disappears the moment the first account exists. Every other account is created
          from Admin &rsaquo; Users.
        </p>
      </div>
    </main>
  );
}
