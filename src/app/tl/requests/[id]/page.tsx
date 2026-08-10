import { requireRole } from '@/lib/auth/rbac';
import { ManagerRequestScreen } from '@/components/managers/manager-request-screen';

export const dynamic = 'force-dynamic';

export default async function TeamLeaderRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireRole('tl');
  const { id } = await params;
  return <ManagerRequestScreen user={user} role="tl" requestId={id} />;
}
