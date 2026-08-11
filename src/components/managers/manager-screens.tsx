import Link from 'next/link';
import type { SessionUser } from '@/lib/auth/rbac';
import { listActionableForUser } from '@/lib/workflows/engine';
import { listMyRequests } from '@/lib/corrections/queries';
import { listTeam, managerSummary } from '@/lib/managers/queries';
import { ageInDays, formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import { CategoryBadge } from '@/components/approvals/request-view';
import {
  Badge,
  Card,
  EmptyState,
  LinkButton,
  PageHeader,
  Pagination,
  StatCard,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';

/**
 * The three manager screens, written once and rendered under both /tl and /acm.
 *
 * A team leader and an area manager do the same job at different widths — review
 * what has reached them, look at who reports to them — so the screens are shared
 * and only the wording differs. Two copies would be two places to fix the day the
 * queue gains a column.
 *
 * The queue is laid out like the verifier's and approver's, down to the ageing
 * badge: a manager is working the same requests through the same chain, and a
 * table that dropped the one column saying how long a rep has been waiting would
 * hide the only thing that distinguishes an urgent rung from a fresh one.
 */

type Role = 'tl' | 'acm';

const WORDS: Record<Role, { team: string; teamOne: string; scope: string }> = {
  tl: { team: 'My team', teamOne: 'rep', scope: 'TL code' },
  acm: { team: 'My teams', teamOne: 'rep', scope: 'ACM code' },
};

/** Shared with the reviewer queues: red at a week, amber at three days. */
function AgeBadge({ days }: { days: number }) {
  return (
    <Badge tone={days >= 7 ? 'danger' : days >= 3 ? 'warning' : 'neutral'}>
      {days} {days === 1 ? 'day' : 'days'}
    </Badge>
  );
}

/* --------------------------------------------------------------- dashboard */

export async function ManagerDashboard({ user, role }: { user: SessionUser; role: Role }) {
  const summary = await managerSummary(user);
  const words = WORDS[role];

  return (
    <section>
      <PageHeader
        title="Dashboard"
        description={
          <>
            Signed in as <span className="font-medium text-slate-800">{user.name}</span> ·{' '}
            {words.scope} <span className="font-mono">{user.tlCode ?? user.acmCode}</span>
          </>
        }
        actions={
          summary.waitingOnMe > 0 ? (
            <LinkButton href={`/${role}/queue`} variant="primary">
              Open the queue
            </LinkButton>
          ) : (
            <LinkButton href={`/${role}/team`}>{words.team}</LinkButton>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Waiting on me"
          value={summary.waitingOnMe}
          hint={summary.waitingOnMe === 0 ? 'Nothing to review right now' : 'Requests at your step'}
          tone={summary.waitingOnMe > 0 ? 'warning' : 'default'}
          href={`/${role}/queue`}
        />
        <StatCard
          label={words.team}
          value={summary.teamSize}
          hint={`${words.teamOne}s beneath you`}
          href={`/${role}/team`}
        />
        <StatCard label="Open in team" value={summary.openInTeam} hint="Raised and not yet decided" />
        <StatCard
          label="Without a login"
          value={summary.repsWithoutAccounts}
          hint={
            summary.repsWithoutAccounts === 0
              ? 'Everyone can sign in'
              : 'Ask an administrator to provision them'
          }
          tone={summary.repsWithoutAccounts > 0 ? 'warning' : 'default'}
        />
      </div>

      <div className="mt-4">
        <Card
          title="What your step does"
          description="Your rung passes the request along or sends it back. It never writes the record."
        >
          <ul className="space-y-1.5 text-[13px] leading-relaxed text-slate-600">
            <li>
              <strong className="text-slate-800">Approve</strong> — the request moves to the next
              rung of its chain. Nothing on the record changes yet.
            </li>
            <li>
              <strong className="text-slate-800">Send back</strong> — the request returns to the rep
              with your remarks, and resubmitting restarts it at rung one rather than at yours.
            </li>
            <li>
              Only the final rung applies the change, so a request that cleared your step can still
              be refused above you.
            </li>
          </ul>
        </Card>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- queue */

export async function ManagerQueue({ user, role }: { user: SessionUser; role: Role }) {
  const rows = await listActionableForUser(user);

  return (
    <section>
      <PageHeader
        title="My approvals"
        description="Correction requests whose current step is yours to decide. Oldest first — a rep cannot raise another correction on the same field while one of theirs is open."
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing waiting on you"
          description="Requests arrive here when their current step resolves to you. Your reps raise them from their own records; nothing you can do puts a row in this table."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Age</Th>
              <Th>Application</Th>
              <Th>Category / field</Th>
              <Th>Change</Th>
              <Th>Concerns rep</Th>
              <Th>Step</Th>
              <Th>Raised</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.requestId} className="hover:bg-slate-50">
                <Td>
                  <AgeBadge days={ageInDays(row.submittedAt)} />
                </Td>
                <Td>
                  <Link
                    href={`/${role}/requests/${row.requestId}`}
                    className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                  >
                    {row.appsNo}
                  </Link>
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
                <Td>
                  <span className="font-mono text-xs">{row.smId}</span>
                </Td>
                <Td>
                  <Badge tone="info">{row.stageKey}</Badge>
                  <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                    {row.stageSequence + 1} of {row.totalStages}
                  </div>
                </Td>
                <Td>
                  <span className="text-xs text-slate-600">{formatDateTime(row.submittedAt)}</span>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------ what I raised */

/**
 * The requests this manager raised, whoever they were raised for.
 *
 * The counterpart to the queue: that one answers "what is waiting on me", this
 * one answers "what did I send off, and where has it got to". A manager had
 * neither until now — a request they raised appeared in no list for either party
 * and was reachable only by following its notification, or by chance when a rung
 * happened to land back on them.
 *
 * Backed by `listMyRequests`, which is the sales screen's own query. Nothing was
 * needed to make it work here: its predicate is `submitted_by = actor.id` for
 * everyone but a rep, so for a manager it already means exactly "raised by me".
 * A second near-identical query would have been a second place for the columns
 * to drift.
 */
const REQUEST_STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'PENDING', label: 'In review' },
  { value: 'VERIFIED', label: 'Part-way up the chain' },
  { value: 'RETURNED', label: 'Back with me' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Closed' },
  { value: 'WITHDRAWN', label: 'Withdrawn' },
] as const;

type SearchParams = Record<string, string | string[] | undefined>;

export async function ManagerRequests({
  user,
  role,
  params,
}: {
  user: SessionUser;
  role: Role;
  params: SearchParams;
}) {
  const { page, pageSize, offset } = parsePageParams(params);
  const statusParam = typeof params.status === 'string' ? params.status : '';
  // Same guard as /sales/requests: an unrecognised status must not fall through
  // to `undefined`, which silently means "All" while a pill claims otherwise.
  const status = REQUEST_STATUS_FILTERS.some((f) => f.value === statusParam && f.value !== '')
    ? statusParam
    : undefined;

  const { rows, total } = await listMyRequests(user, { offset, limit: pageSize, status });

  return (
    <section>
      <PageHeader
        title="Requests I raised"
        description="Corrections you raised on behalf of your reps, and where each has got to. The rep sees these too, read-only — only you can resubmit or withdraw one."
        actions={
          <LinkButton href={`/${role}/requests/new`} variant="primary">
            Raise a request
          </LinkButton>
        }
      />

      <nav aria-label="Filter by status" className="mb-3 flex flex-wrap gap-1.5">
        {REQUEST_STATUS_FILTERS.map((filter) => {
          const active = (status ?? '') === filter.value;
          return (
            <Link
              key={filter.value || 'all'}
              href={`/${role}/requests${buildQuery(params, { status: filter.value, page: undefined })}`}
              aria-current={active ? 'page' : undefined}
              className={
                active
                  ? 'rounded-md border border-slate-900 bg-slate-900 px-2.5 py-1 text-[12px] font-medium text-white'
                  : 'rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50'
              }
            >
              {filter.label}
            </Link>
          );
        })}
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title={status ? 'Nothing in this state' : 'You have not raised anything yet'}
          description={
            status ? (
              <>
                No request you raised is currently {status.toLowerCase()}.{' '}
                <Link href={`/${role}/requests`} className="underline">
                  Show all of them
                </Link>
                .
              </>
            ) : (
              <>
                A row appears here when you{' '}
                <Link href={`/${role}/requests/new`} className="underline">
                  raise a correction
                </Link>{' '}
                against one of your reps records. Requests your reps raise themselves are not
                listed — those reach you through your queue when a step is yours to decide.
              </>
            )
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Application</Th>
                <Th>Rep</Th>
                <Th>Category / field</Th>
                <Th>Status</Th>
                <Th>Step</Th>
                <Th>Raised</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-slate-50">
                  <Td>
                    <Link
                      href={`/${role}/requests/${row.id}`}
                      className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                    >
                      {row.appsNo}
                    </Link>
                    <div className="mt-0.5">
                      <span className="font-mono text-xs text-slate-500">
                        {orDash(row.originalValue)}
                      </span>
                      <span className="px-1 text-slate-400" aria-label="becomes">
                        →
                      </span>
                      <span className="font-mono text-xs font-medium text-slate-900">
                        {orDash(row.proposedValue)}
                      </span>
                    </div>
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
                    <StatusBadge status={row.status} />
                    {row.resubmissionCount > 0 ? (
                      <div className="mt-0.5 text-xs text-slate-500">
                        resubmitted {row.resubmissionCount}×
                      </div>
                    ) : null}
                  </Td>
                  {/* Null once it is decided — there is no open rung to name, and
                      "6 of 5" would be worse than nothing. */}
                  <Td>
                    {row.currentStageKey ? (
                      <>
                        <Badge tone="info">{row.currentStageKey}</Badge>
                        <div className="mt-0.5 text-xs tabular-nums text-slate-500">
                          {row.currentStageSequence + 1} of {row.totalStages}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs text-slate-500">Finished</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-slate-600">
                    {formatDateTime(row.submittedAt)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            page={page}
            pageCount={pageCount(total, pageSize)}
            totalRows={total}
            hrefFor={(next) => `/${role}/requests${buildQuery(params, { page: next })}`}
          />
        </>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------- team */

export async function ManagerTeam({ user, role }: { user: SessionUser; role: Role }) {
  const team = await listTeam(user);
  const words = WORDS[role];

  return (
    <section>
      <PageHeader
        title={words.team}
        description="Everyone the roster places beneath you, including any admin reassignments."
      />

      {team.length === 0 ? (
        <EmptyState
          title="No reps are placed beneath you yet"
          description="The Manpower sheet is what places a rep under a manager. Until an administrator imports one that names your code, this list stays empty."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>SM_ID</Th>
              <Th>Name</Th>
              {role === 'acm' ? <Th>Team leader</Th> : null}
              <Th>Location</Th>
              <Th className="text-right">Records</Th>
              <Th className="text-right">Open requests</Th>
              <Th>Login</Th>
            </tr>
          </thead>
          <tbody>
            {team.map((member) => (
              <tr key={member.smId} className="hover:bg-slate-50">
                <Td>
                  <span className="font-mono font-medium text-slate-900">{member.smId}</span>
                </Td>
                <Td>{orDash(member.smName)}</Td>
                {role === 'acm' ? (
                  <Td>
                    <span className="font-mono text-xs">{orDash(member.tlId)}</span>
                  </Td>
                ) : null}
                <Td>{orDash(member.location)}</Td>
                <Td className="text-right tabular-nums">{member.recordCount}</Td>
                <Td className="text-right tabular-nums">
                  {member.openRequests > 0 ? (
                    <span className="font-medium text-amber-700">{member.openRequests}</span>
                  ) : (
                    member.openRequests
                  )}
                </Td>
                <Td>
                  {member.hasAccount ? (
                    <StatusBadge status="ACTIVE" />
                  ) : (
                    <Badge tone="warning">No account</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </section>
  );
}
