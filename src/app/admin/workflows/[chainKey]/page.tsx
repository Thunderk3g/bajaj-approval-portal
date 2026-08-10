import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { CHAIN_KEYS, CHAIN_LABELS, countInFlight, getChain, type ChainKey } from '@/lib/workflows/chains';
import { Alert, Card, PageHeader } from '@/components/ui';
import { ChainEditor, type ResolverOption } from './chain-editor';

/**
 * Who can be put on a step, described in the words an admin thinks in.
 *
 * The `key` is what the engine resolves with; everything else on the row exists
 * so nobody has to know that. Verifier slots are separate options rather than one
 * "verifier" with a number field, because the slots are how the business talks
 * about them — "it goes to V2" — and a dropdown of the real names is shorter than
 * a name plus a number.
 */
const RESOLVERS: ResolverOption[] = [
  {
    id: 'TL',
    resolverKey: 'TL_OF_SM',
    label: 'Team leader',
    hint: 'The TL the roster places over the rep — resolved per request.',
    needsSide: true,
  },
  {
    id: 'ACM',
    resolverKey: 'ACM_OF_SM',
    label: 'Area manager',
    hint: 'The ACM above that rep’s team — resolved per request.',
    needsSide: true,
  },
  /**
   * V1 … V5 are review POSITIONS filled by named people, not role pools.
   *
   * The business creates a verifier, decides they are V2, and expects V2 to mean
   * that person. Resolving the slot to "anybody holding the verifier role" would
   * send it to everyone at once, which is neither who they mean nor how the desk
   * is staffed — and the person filling one is usually a team leader or an area
   * manager rather than a dedicated verifier account.
   */
  ...['V1', 'V2', 'V3', 'V4', 'V5 (QA)'].map((slot) => ({
    id: `VERIFIER_${slot}`,
    resolverKey: 'USER',
    label: slot,
    hint: 'A named reviewer. Pick the person who holds this position.',
    needsSide: false,
    needsAssignee: true,
    baseConfig: {},
  })),
  {
    id: 'APPROVER',
    resolverKey: 'ROLE',
    label: 'Approver (any)',
    hint: 'The final decision, open to anyone holding the approver role.',
    needsSide: false,
    baseConfig: { role: 'approver' },
  },
  {
    id: 'APPROVER_NAMED',
    resolverKey: 'USER',
    label: 'Approver (a named person)',
    hint: 'The final decision, reserved to one person.',
    needsSide: false,
    needsAssignee: true,
    baseConfig: {},
  },
];

export default async function ChainDetailPage({
  params,
}: {
  params: Promise<{ chainKey: string }>;
}) {
  // Redirected rather than thrown, same as the chain list and every other admin
  // page: the layout's redirect races this render, so an escaping AuthzError
  // reaches the browser as an error screen instead of the sign-in page.
  try {
    await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const { chainKey } = await params;
  if (!(CHAIN_KEYS as readonly string[]).includes(chainKey)) notFound();

  const chain = await getChain(chainKey as ChainKey);
  if (!chain) notFound();

  const inFlight = await countInFlight(chainKey as ChainKey);

  /**
   * Who can be put on a review position.
   *
   * Sales accounts are excluded: a rep reviewing corrections raised against their
   * own book is the conflict this whole pipeline exists to remove. Everyone else
   * with an active account is offered, because the business fills these positions
   * with team leaders and area managers as readily as with dedicated verifiers.
   */
  const assignable = (
    await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        smId: user.smId,
        tlCode: user.tlCode,
        acmCode: user.acmCode,
      })
      .from(user)
      .where(and(eq(user.isActive, true), ne(user.role, 'sales')))
      .orderBy(asc(user.role), asc(user.name))
  ).map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    scope: u.tlCode ?? u.acmCode ?? u.smId,
  }));

  return (
    <section className="space-y-6">
      <PageHeader
        title={CHAIN_LABELS[chainKey as ChainKey]}
        description="Drag a step to move it, or use the arrows. The last step is always the one that applies the change and the only one that can reject outright."
        actions={
          <Link className="text-sm font-medium underline" href="/admin/workflows">
            All chains
          </Link>
        }
      />

      {inFlight > 0 ? (
        <Alert tone="info">
          {inFlight} request{inFlight === 1 ? ' is' : 's are'} currently moving through this chain.
          They each hold their own copy of the steps and will finish exactly as they started —
          anything you change here applies to new requests only.
        </Alert>
      ) : null}

      <Card
        title="Steps"
        description="In order, top to bottom. A request clears each one before reaching the next."
      >
        <ChainEditor
          chainKey={chainKey}
          resolvers={RESOLVERS}
          assignable={assignable}
          initial={chain.stages.map((s) => ({
            stageKey: s.stageKey,
            resolverKey: s.resolverKey,
            resolverConfig: s.resolverConfig,
          }))}
        />
      </Card>

      <Card
        title="What happens when a step cannot be routed"
        description="A team leader or area manager step resolves to a real person through the roster."
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>
            If the roster does not place the rep under anyone, the step opens anyway and every
            administrator is notified — the request is never stranded behind data the reviewer
            cannot fix.
          </li>
          <li>
            If the roster names a manager who has no portal account, the same happens, and the gap
            is listed on <Link className="underline" href="/admin/hierarchy">Hierarchy</Link>.
          </li>
        </ul>
      </Card>
    </section>
  );
}
