import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Not available · Sales Data Review Portal',
};

/**
 * Deliberately neutral wording. Confirming that a page exists but is barred
 * would tell a curious user which sections of the portal they are missing;
 * "not available" covers both "does not exist" and "not yours".
 */
export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">Not available</h1>
        <p className="mt-2 text-sm text-slate-600">
          This page is not available for your account. If you believe you need access, contact your
          portal administrator.
        </p>
        <Link
          href="/"
          className="mt-5 inline-block rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
        >
          Back to my dashboard
        </Link>
      </div>
    </main>
  );
}
