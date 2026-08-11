import type { Metadata } from 'next';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { loadHierarchyTree, loadUnplacedReps } from '@/lib/hierarchy/actions';
import { listHierarchyGaps } from '@/lib/hierarchy/queries';
import { Alert, Badge, Card, LinkButton, PageHeader, Table, Td, Th } from '@/components/ui';
import { PeopleTabs } from '@/components/admin/people-tabs';
import { HierarchyTree } from './hierarchy-tree';

export const metadata: Metadata = {
  title: 'Hierarchy · Sales Data Review Portal',
};

export const dynamic = 'force-dynamic';

/**
 * The roster tree, and everywhere it is incomplete — 2026-08-06 spec section 5.
 *
 * Two audiences on one screen. The worklist at the top is for the administrator
 * who has to make routing work: every manager code no account carries is a step
 * that will open, resolve to nobody and land on the admins. The tree below is
 * both the reference and the editor — who reports to whom, and the place it gets
 * changed.
 *
 * `requireRole` runs here rather than being left to the layout. A layout guard
 * protects the render; it does not protect the Server Actions this page hands to
 * the browser, and every admin page in this portal states its own requirement for
 * that reason.
 */
export default async function HierarchyPage() {
  await requireRoleOrRedirect('admin');

  const [teams, unplaced, gaps] = await Promise.all([
    loadHierarchyTree(),
    loadUnplacedReps(),
    listHierarchyGaps(),
  ]);

  const unprovisioned = gaps.filter((gap) => gap.kind !== 'SM_UNPLACED');

  // Reps who still carry a reporting line but have fallen off the latest sheet.
  // The tree excludes them, so without this count they vanish from the screen
  // that is supposed to be the whole picture.
  const orphaned = gaps.filter((gap) => gap.kind === 'SM_UNPLACED').length - unplaced.length;

  return (
    <section className="space-y-4">
      <PeopleTabs current="/admin/hierarchy" />

      <PageHeader
        title="Hierarchy"
        description="Who reports to whom. Drag a rep onto a team to move that person, or drag a team onto an area manager to move it with everyone under it. The Manpower sheet writes this line; an edit here overrides it and survives every later import until it is released."
      />

      {unprovisioned.length > 0 ? (
        <Card
          title="Managers without a login"
          description="The roster names these codes as approvers, but no active account carries them. Any step routed to one of these falls to the administrators instead."
          // The worklist lists these same codes at their own rung and creates the
          // accounts in one pass. Naming a gap without a route to the screen that
          // closes it is how a card becomes something people stop reading.
          actions={
            <LinkButton href="/admin/users" variant="primary">
              Create their accounts
            </LinkButton>
          }
        >
          <Table>
            <thead>
              <tr>
                <Th>Rung</Th>
                <Th>Code</Th>
                <Th>Name on the sheet</Th>
                <Th className="text-right">Reps affected</Th>
              </tr>
            </thead>
            <tbody>
              {unprovisioned.map((gap) => (
                <tr key={`${gap.kind}-${gap.code}`}>
                  <Td>
                    <Badge tone="warning">
                      {gap.kind === 'TL_UNPROVISIONED' ? 'Team leader' : 'Area manager'}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="font-mono text-[13px]">{gap.code}</span>
                  </Td>
                  <Td>{gap.name ?? <span className="text-slate-400">—</span>}</Td>
                  <Td className="text-right tabular-nums">{gap.smCount}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {orphaned > 0 ? (
        <Alert tone="warning">
          {orphaned} rep{orphaned === 1 ? '' : 's'} still carry a reporting line but no longer appear
          on the latest Manpower sheet, so they are left out of the tree below. Importing an
          up-to-date sheet is the fix.
        </Alert>
      ) : null}

      <HierarchyTree initial={teams} unplaced={unplaced} />
    </section>
  );
}
