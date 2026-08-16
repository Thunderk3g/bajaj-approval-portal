import Link from 'next/link';
import type { SessionUser } from '@/lib/auth/rbac';
import { listTeamRequests } from '@/lib/managers/queries';
import { ageInDays, formatDateTime, orDash } from '@/lib/format';
import { CategoryBadge } from '@/components/approvals/request-view';
import { Badge, Card, EmptyState, LinkButton, PageHeader, StatCard, StatusBadge, Table, Td, Th } from '@/components/ui';

/**
 * Where this manager's team's work is stuck.
 *
 * The counterpart to their own queue, and the half that was missing. The queue
 * answers "what is waiting on me"; this answers "what is waiting, anywhere,
 * under me" — which is the question the dashboard's "Open in team" figure was
 * posing without offering an answer, because that tile was a number with no
 * screen behind it.
 *
 * The distinction matters most for the requests a manager can do nothing about
 * directly. A correction parked at a verification rung two steps above them is
 * invisible in their queue by design and is precisely what they are asked about
 * when a rep chases it. Naming the open rung and its age turns "I'll find out"
 * into an answer given on the spot.
 */
export async function TeamRequestsScreen({
  user,
  role,
  params,
}: {
  user: SessionUser;
  role: 'tl' | 'acm';
  params: Record<string, string | string[] | undefined>;
}) {
  const smId = typeof params.smId === 'string' ? params.smId : null;
  const rows = await listTeamRequests(user, { smId });

  const waitingOnMe = rows.filter((r) => r.mine).length;
  const stuck = rows.filter((r) => r.unresolved).length;
  const oldest = rows.reduce((max, r) => Math.max(max, ageInDays(r.submittedAt)), 0);

  return (
    <section>
      <PageHeader
        title="Open in my team"
        description={
          smId ? (
            <>
              Corrections raised on <span className="font-mono">{smId}</span>&apos;s records that
              have not been decided.{' '}
              <Link href={`/${role}/requests/team`} className="underline">
                Show the whole team
              </Link>
              .
            </>
          ) : (
            'Every correction in flight anywhere beneath you, whoever raised it and whoever it is waiting on. Oldest first.'
          )
        }
        actions={<LinkButton href={`/${role}/queue`}>My approvals</LinkButton>}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open in team" value={rows.length} hint="Raised and not yet decided" />
        <StatCard
          label="At my step"
          value={waitingOnMe}
          tone={waitingOnMe > 0 ? 'warning' : 'default'}
          hint={waitingOnMe === 0 ? 'Nothing needs you right now' : 'Yours to decide'}
          href={`/${role}/queue`}
        />
        <StatCard
          label="Oldest waiting"
          value={`${oldest}d`}
          tone={oldest >= 7 ? 'danger' : 'default'}
          hint="Days since the rep submitted it"
        />
        {/* Only rendered as a warning when it happens: a rung that resolved to
            nobody is not a state a manager can fix, so it is a thing to escalate
            rather than a permanent column of zeroes. */}
        <StatCard
          label="Stuck on an administrator"
          value={stuck}
          tone={stuck > 0 ? 'danger' : 'default'}
          hint={
            stuck === 0
              ? 'Every open step has somebody on it'
              : 'The step resolved to nobody — ask an administrator'
          }
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={smId ? 'Nothing open for this rep' : 'Nothing your team raised is in flight'}
          description="A row appears here when anyone beneath you raises a correction, and leaves it when the chain finishes. Your reps raise them from their own records."
        />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Age</Th>
                <Th>Application</Th>
                <Th>Rep</Th>
                <Th>Category / field</Th>
                <Th>Change</Th>
                <Th>Waiting on</Th>
                <Th>Raised</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const age = ageInDays(row.submittedAt);
                return (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <Td>
                      <Badge tone={age >= 7 ? 'danger' : age >= 3 ? 'warning' : 'neutral'}>
                        {age} {age === 1 ? 'day' : 'days'}
                      </Badge>
                    </Td>
                    <Td>
                      <Link
                        href={`/${role}/requests/${row.id}`}
                        className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                      >
                        {row.appsNo}
                      </Link>
                    </Td>
                    <Td>
                      {orDash(row.smName)}
                      <div className="mt-0.5 font-mono text-xs text-slate-500">{row.smId}</div>
                    </Td>
                    <Td>
                      <CategoryBadge category={row.category} />
                      <div className="mt-0.5 text-xs text-slate-500">{row.fieldLabel}</div>
                    </Td>
                    <Td>
                      <span className="font-mono text-xs text-slate-500">
                        {orDash(row.originalValue)}
                      </span>
                      <span className="px-1 text-slate-400" aria-label="becomes">
                        →
                      </span>
                      <span className="font-mono text-xs font-medium text-slate-900">
                        {orDash(row.proposedValue)}
                      </span>
                    </Td>
                    {/* The column this screen exists for. A status badge alone
                        says VERIFIED for a request sitting with a team leader,
                        a second verifier or an area manager — three different
                        answers to the only question being asked. */}
                    <Td>
                      {row.stageKey ? (
                        <>
                          <Badge
                            tone={row.mine ? 'warning' : row.unresolved ? 'danger' : 'info'}
                          >
                            {row.mine
                              ? `You — ${row.stageKey}`
                              : row.unresolved
                                ? `Nobody — ${row.stageKey}`
                                : row.stageKey}
                          </Badge>
                          <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                            step {(row.stageSequence ?? 0) + 1} of {row.totalStages}
                          </div>
                        </>
                      ) : (
                        <StatusBadge status={row.status} />
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-600">
                      {formatDateTime(row.submittedAt)}
                      <div className="mt-0.5 text-slate-500">{orDash(row.submitterName)}</div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </section>
  );
}
