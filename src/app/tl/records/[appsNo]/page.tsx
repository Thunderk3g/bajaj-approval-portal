import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerRecordDetail } from '@/components/records/manager-records';

export const metadata: Metadata = {
  title: 'Record · Sales Data Review Portal',
};

export default async function TeamLeaderRecordDetailPage({
  params,
}: {
  params: Promise<{ appsNo: string }>;
}) {
  const user = await requireRoleOrRedirect('tl');
  const { appsNo } = await params;
  return <ManagerRecordDetail user={user} role="tl" appsNo={appsNo} />;
}
