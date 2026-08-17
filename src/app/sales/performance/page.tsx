import type { Metadata } from 'next';
import {
  Alert,
  Badge,
  Card,
  EmptyState,
  Meter,
  PageHeader,
  StatCard,
  Table,
  Td,
  Th,
  buttonClass,
} from '@/components/ui';
import { AuthzError } from '@/lib/auth/errors';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { OutcomeReasons, PeerComparison } from '@/components/charts/performance-view';
import {
  formatPercent,
  issuanceRate,
  loadOutcomeReasons,
  loadRepStanding,
  ratio,
  rejectionRate,
  resolvePeriodFilter,
  type OutcomeReason,
  type PerformanceMetrics,
  type RepStanding,
} from '@/lib/dashboard/performance';
import { formatMoney } from '@/lib/format';
import type { SearchParams } from '@/lib/records/filters';

export const metadata: Metadata = {
  title: 'My performance · Sales Data Review Portal',
};

const n = (value: number) => value.toLocaleString('en-IN');

/**
 * A rep's own figures, and where they stand — never their peers' rows.
 *
 * The comparison is against the team TOTAL and the team AVERAGE, both of which
 * are aggregates nobody can be identified from. Listing the other reps here
 * would turn a rep's own dashboard into a leaderboard of colleagues they have
 * no business reading, and `scopedRecordCondition` is deliberately narrow for a
 * sales account for exactly that reason. `loadRepStanding` resolves the team
 * from the roster against this account's own SM_ID, so there is no team code in
 * the URL for anybody to swap.
 */
export default async function SalesPerformancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('sales');
  const params = await searchParams;
  const requested = Array.isArray(params.period) ? params.period[0] : (params.period ?? '');
  const period = await resolvePeriodFilter(requested);

  let standing: RepStanding;
  let reasons: OutcomeReason[] = [];
  try {
    [standing, reasons] = await Promise.all([
      loadRepStanding(viewer, period.periodId),
      loadOutcomeReasons(viewer, period.periodId),
    ]);
  } catch (error) {
    if (error instanceof AuthzError) {
      return (
        <section>
          <PageHeader title="My performance" />
          <Alert tone="danger" title="This account carries no SM_ID">
            Your figures are read off your sales manager code and your login does not have one, so
            there is nothing this page can show you. An administrator can set it on the People
            screen.
          </Alert>
        </section>
      );
    }
    throw error;
  }

  const { own, team, teamSize } = standing;
  const unknownPeriod = requested !== '' && requested !== 'all' && !period.options.some((o) => o.code === requested);
  const share = ratio(own.logins, team.logins);
  const average = teamSize > 0 ? team.logins / teamSize : null;

  return (
    <section>
      <PageHeader
        title="My performance"
        description={
          <>
            Every application logged under{' '}
            <span className="font-mono text-[12px] text-slate-900">{viewer.smId}</span>, and how the
            team around you is doing. Colleagues&rsquo; individual figures are not shown here.
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="performance-period"
            className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500"
          >
            Period
          </label>
          <select
            id="performance-period"
            name="period"
            defaultValue={period.code || 'all'}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-[5px] text-[12px] text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
          >
            <option value="all">All periods</option>
            {period.options.map((option) => (
              <option key={option.code} value={option.code}>
                {option.label}
                {option.status === 'CLOSED' ? ' (closed)' : ''}
              </option>
            ))}
          </select>
          <button type="submit" className={buttonClass('secondary')}>
            Apply
          </button>
        </form>
      </div>

      {unknownPeriod ? (
        <div className="mb-4">
          <Alert tone="warning" title={`No period is coded ${requested}`}>
            The link you followed names a month the portal does not hold, so this is every period.
          </Alert>
        </div>
      ) : null}

      {own.unclassified > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`${n(own.unclassified)} of your applications carry a status the portal does not recognise`}
          >
            They are counted as pending so that issued, rejected and pending still add up to your
            logins — but the issuance figure below is understated until somebody says what that
            status means. Worth raising with your team leader.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="My logins" value={n(own.logins)} hint="Applications submitted" />
        <StatCard
          label="Issued"
          value={n(own.issued)}
          hint={`${formatPercent(issuanceRate(own))} of my logins`}
          tone={own.issued > 0 ? 'success' : 'default'}
        />
        <StatCard
          label="Rejected"
          value={n(own.rejected)}
          hint={`${formatPercent(rejectionRate(own))} of my logins`}
          tone={own.rejected > 0 ? 'danger' : 'default'}
        />
        <StatCard label="My ANP" value={formatMoney(own.anp)} hint={`FP ${formatMoney(own.fp)}`} />
      </div>

      <div className="mt-4">
        {own.logins === 0 && team.logins === 0 ? (
          <EmptyState
            title="Nothing logged in this period"
            description="Your applications appear here once an administrator commits the business dashboard for this month. If you know a policy is missing, raise a mapping correction against it."
          />
        ) : (
          <Card
            title="Where I stand"
            description={
              standing.tlId
                ? `Against the whole of ${
                    standing.tlName ? `${standing.tlName}'s` : "your team leader's"
                  } team — ${n(teamSize)} rep${teamSize === 1 ? '' : 's'} on the roster.`
                : 'The roster places you under no team leader, so there is no team to compare against. An administrator can fix that on the Hierarchy screen.'
            }
          >
            {standing.tlId ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Measure</Th>
                    <Th className="text-right">Me</Th>
                    <Th className="text-right">My team</Th>
                    <Th>Comparison</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <Td>Logins</Td>
                    <Td className="text-right tabular-nums">{n(own.logins)}</Td>
                    <Td className="text-right tabular-nums">{n(team.logins)}</Td>
                    <Td className="min-w-[9rem]">
                      <Meter value={share} />
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        my share of the team&rsquo;s logins
                        {average === null
                          ? ''
                          : ` · team average ${average.toLocaleString('en-IN', {
                              maximumFractionDigits: 1,
                            })} per rep`}
                      </span>
                    </Td>
                  </tr>
                  <Comparison label="Issuance" mine={issuanceRate(own)} theirs={issuanceRate(team)} />
                  <Comparison
                    label="Rejection"
                    mine={rejectionRate(own)}
                    theirs={rejectionRate(team)}
                    lowerIsBetter
                  />
                  <tr>
                    <Td>ANP</Td>
                    <Td className="text-right tabular-nums">{formatMoney(own.anp)}</Td>
                    <Td className="text-right tabular-nums">{formatMoney(team.anp)}</Td>
                    <Td className="min-w-[9rem]">
                      <Meter value={ratio(Number(own.anp), Number(team.anp))} />
                      <span className="mt-0.5 block text-[11px] text-slate-500">
                        my share of the team&rsquo;s ANP
                      </span>
                    </Td>
                  </tr>
                  <StatusRow own={own} />
                </tbody>
              </Table>
            ) : null}
          </Card>
        )}
      </div>

      {/* A rank among the team, and not one colleague's row — `loadRepStanding`
          reduces the peers to a position before they ever reach this page, and
          it resolves the team from the roster rather than from the URL. */}
      {standing.standing ? (
        <div className="mt-4">
          <PeerComparison standing={standing.standing} />
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="mt-4">
          <OutcomeReasons reasons={reasons} totals={own} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * One rate, mine against the team's, with the gap stated in words.
 *
 * The words matter: a bar longer than another bar is the sort of status that
 * ui-flows §9 refuses to let colour or length carry alone, and "3.4 points
 * above the team" is the sentence a rep would otherwise have to work out.
 */
function Comparison({
  label,
  mine,
  theirs,
  lowerIsBetter,
}: {
  label: string;
  mine: number | null;
  theirs: number | null;
  lowerIsBetter?: boolean;
}) {
  const gap = mine === null || theirs === null ? null : (mine - theirs) * 100;
  const good = gap === null ? null : lowerIsBetter ? gap <= 0 : gap >= 0;

  return (
    <tr>
      <Td>{label}</Td>
      <Td className="text-right tabular-nums">{formatPercent(mine)}</Td>
      <Td className="text-right tabular-nums">{formatPercent(theirs)}</Td>
      <Td className="min-w-[9rem]">
        <Meter value={mine} tone={lowerIsBetter ? 'negative' : 'positive'} />
        <span className="mt-0.5 block text-[11px] text-slate-500">
          {gap === null ? (
            'no logins to compare'
          ) : (
            <>
              {Math.abs(gap).toFixed(1)} points {gap === 0 ? 'level with' : gap > 0 ? 'above' : 'below'}{' '}
              the team
              {good === null ? null : (
                <span className="ml-1.5">
                  <Badge tone={good ? 'success' : 'warning'}>{good ? 'ahead' : 'behind'}</Badge>
                </span>
              )}
            </>
          )}
        </span>
      </Td>
    </tr>
  );
}

/** Pending is the remainder, so this row is what makes the three add up on screen. */
function StatusRow({ own }: { own: PerformanceMetrics }) {
  return (
    <tr>
      <Td>Pending</Td>
      <Td className="text-right tabular-nums">{n(own.pending)}</Td>
      <Td className="text-right tabular-nums">—</Td>
      <Td className="text-[11px] text-slate-500">
        {n(own.issued)} issued + {n(own.rejected)} rejected + {n(own.pending)} pending ={' '}
        {n(own.logins)} logins
      </Td>
    </tr>
  );
}
