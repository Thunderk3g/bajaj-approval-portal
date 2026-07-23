import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Approver dashboard · Sales Data Review Portal',
};

export default function ApproverDashboardPage() {
  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Approver dashboard</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Correction requests waiting on your decision appear here once an upload has been committed
        and sales users have raised requests.
      </p>
    </section>
  );
}
