import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { listChains } from '@/lib/workflows/chains';
import { Alert, Badge, Card, EmptyState, PageHeader, Table, Td, Th } from '@/components/ui';
import { ChainToggle } from './chain-toggle';

/**
 * Every approval chain, and what it currently does.
 *
 * requireRole here as well as in the layout: a route that trusts its parent to
 * have checked is one refactor away from being reachable without one.
 *
 * Its refusal is turned into a redirect here rather than left to propagate,
 * which is what every other admin page does and why this one was the only route
 * that answered a non-admin with a crash. A layout and its page render in
 * parallel: the layout's redirect does not pre-empt this check, so an
 * unhandled AuthzError reaches the client as `digest: '…'` and an error screen
 * instead of the sign-in page the layout was already sending them to.
 */
export default async function WorkflowsPage() {
  try {
    await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const chains = await listChains();

  return (
    <section className="space-y-6">
      <PageHeader
        title="Approval chains"
        description="Which steps a correction has to clear, per kind of correction. Editing a chain changes what happens to NEW requests; anything already moving finishes on the chain it started."
      />

      {chains.length === 0 ? (
        <Card>
          <EmptyState
            title="No chains are configured"
            description="Corrections cannot be raised until every kind has a chain. Run: npx tsx scripts/seed-workflow-chains.ts"
          />
        </Card>
      ) : (
        <>
          {chains.some((c) => c.unstaffedStageKeys.length > 0) ? (
            <Alert tone="warning" title="Some chains have steps with nobody on them">
              A step below names nobody, or names an account that has since been deleted or
              deactivated. Either way it resolves to no one: a request routed onto it opens,
              waits, and moves no further — the administrators are told, and nothing else on any
              screen says why. Naming somebody here also routes every request already stranded on
              that step, so they do not have to be raised again.
            </Alert>
          ) : null}

          <Alert tone="info">
            A step is either a <strong>pool</strong> — anyone holding that role may act — or a{' '}
            <strong>named person</strong> resolved from the roster, such as the team leader of the
            rep the request concerns. Open a chain to reorder its steps by dragging them.
          </Alert>

          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Kind of correction</Th>
                  <Th>Steps, in order</Th>
                  <Th>Status</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody>
                {chains.map((chain) => (
                  <tr key={chain.id}>
                    <Td>
                      <div className="font-medium">{chain.label}</div>
                      <div className="font-mono text-xs text-slate-500">{chain.chainKey}</div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-1">
                        {chain.stageKeys.map((key, index) => (
                          <span key={`${key}-${index}`} className="flex items-center gap-1">
                            {index > 0 ? <span className="text-slate-400">→</span> : null}
                            <Badge tone={index === chain.stageKeys.length - 1 ? 'success' : 'neutral'}>
                              {key}
                            </Badge>
                          </span>
                        ))}
                      </div>
                    </Td>
                    <Td>
                      {chain.isActive ? (
                        <Badge tone="success">Active</Badge>
                      ) : (
                        <Badge tone="warning">Off — no new requests</Badge>
                      )}
                      {chain.unstaffedStageKeys.length > 0 ? (
                        <div className="mt-1">
                          <Badge tone="danger">
                            Nobody on {chain.unstaffedStageKeys.join(', ')}
                          </Badge>
                        </div>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-3">
                        <Link
                          className="text-sm font-medium underline"
                          href={`/admin/workflows/${chain.chainKey}`}
                        >
                          Edit
                        </Link>
                        <ChainToggle chainKey={chain.chainKey} isActive={chain.isActive} />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </section>
  );
}
