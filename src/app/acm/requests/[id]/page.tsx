import { requireRole } from '@/lib/auth/rbac';
import { ManagerRequestScreen } from '@/components/managers/manager-request-screen';

export const dynamic = 'force-dynamic';

export default async function AreaManagerRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireRole('acm');
  const { id } = await params;
  return <ManagerRequestScreen user={user} role="acm" requestId={id} />;
}
