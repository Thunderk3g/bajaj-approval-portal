import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Card, LinkButton, PageHeader } from '@/components/ui';
import { RecordDetail } from '@/components/records/record-detail';
import { VersionHistory } from '@/components/records/version-history';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { getRecord } from '@/lib/records/query';
import { listRecordVersions } from '@/lib/records/versions';

export const metadata: Metadata = {
  title: 'Record · Sales Data Review Portal',
};

export default async function AdminRecordDetailPage({
  params,
}: {
  params: Promise<{ appsNo: string }>;
}) {
  let viewer: SessionUser;
  try {
    viewer = await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const { appsNo } = await params;
  const record = await getRecord(viewer, appsNo);
  if (!record) notFound();

  const versions = await listRecordVersions(viewer, appsNo);

  return (
    <section className="space-y-4">
      <PageHeader
        title={`Application ${record.appsNo}`}
        description={
          <>
            Credited to <span className="font-mono">{record.smId}</span>
            {record.smName ? ` — ${record.smName}` : ''}
          </>
        }
        actions={<LinkButton href="/admin/records">Back to records</LinkButton>}
      />

      <RecordDetail record={record} />

      <Card
        title="Version history"
        description="Every change, newest first, each diffed against the version before it."
      >
        <VersionHistory versions={versions} />
      </Card>
    </section>
  );
}
