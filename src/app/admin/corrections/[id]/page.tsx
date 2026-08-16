import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { ManagerRequestScreen } from '@/components/managers/manager-request-screen';

export const metadata: Metadata = {
  title: 'Correction request · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

/**
 * One correction request, for an administrator.
 *
 * This route is the other half of a promise the engine has been making for a
 * while and could not keep. When a rung resolves to nobody — the roster places a
 * rep under no team leader, or names a manager who has no portal account —
 * `openStage` opens it anyway, notifies the administrators and links them to
 * `/admin/corrections/${'{'}requestId{'}'}`. That route did not exist, so the
 * notification landed on a 404 and the request stopped moving with nothing on any
 * screen saying why. The escape hatch was documented, wired, and dead.
 *
 * It renders the reviewers' own screen rather than a fourth variant of it. An
 * admin clearing a stuck rung needs exactly what a manager sees — the comparison,
 * the record, the proof, the chain so far — and `assertMayDecide` has always
 * accepted an admin on an unresolved rung, so the decision form beside it is not
 * a new privilege, only the first way to exercise one.
 */
export default async function AdminCorrectionRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireRoleOrRedirect('admin');
  const { id } = await params;

  return <ManagerRequestScreen user={user} role="admin" requestId={id} />;
}
