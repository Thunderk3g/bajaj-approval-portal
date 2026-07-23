import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Admin dashboard · Sales Data Review Portal',
};

export default function AdminDashboardPage() {
  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Admin dashboard</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Upload activity, correction volumes and record counts appear here once an upload has been
        committed.
      </p>
    </section>
  );
}
