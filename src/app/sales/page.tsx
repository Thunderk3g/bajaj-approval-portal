import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sales dashboard · Sales Data Review Portal',
};

export default function SalesDashboardPage() {
  return (
    <section>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">Sales dashboard</h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Records for your SM_ID and the status of your correction requests appear here once an upload
        has been committed.
      </p>
    </section>
  );
}
