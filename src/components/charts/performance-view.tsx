import Link from 'next/link';
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
  cx,
} from '@/components/ui';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { formatMoney } from '@/lib/format';
import {
  RUNG_LABELS,
  OUTCOMES,
  formatPercent,
  issuanceRate,
  loadManagerStanding,
  loadOutcomeReasons,
  loadPerformance,
  loginShare,
  parsePerformanceParams,
  rejectionRate,
  resolvePeriodFilter,
  sortPerformanceRows,
  type OutcomeReason,
  type PeerStanding,
  type PerformanceMetrics,
  type PerformanceParams,
  type PerformanceReport,
  type PerformanceRow,
  type PerformanceRung,
  type PerformanceSort,
} from '@/lib/dashboard/performance';

/**
 * The performance report, rendered once for four routes.
 *
 * There is one module behind /admin, /tl, /acm and /sales performance and there
 * is one screen too. The product owner's feedback round will change what these
 * columns mean; four copies of this table would be four places to change it and
 * three places to forget.
 *
 * A server component with no client state. Sorting is a link, the period filter
 * is a plain GET form, and the rung switcher is three links — all of which
 * survive with JavaScript off and none of which drags this page into the
 * browser bundle. The bubbles chart next door makes the same trade.
 */

const n = (value: number) => value.toLocaleString('en-IN');

/**
 * Everything /admin, /tl and /acm performance do, so the routes stay wrappers.
 *
 * The three pages differ by four strings and which rungs they may switch
 * between. Anything more than that living in the route file is a copy that will
 * drift the first time the report changes — and it is going to change, because
 * the product owner has not seen it yet.
 */
export async function PerformanceScreen({
  viewer,
  params,
  rungs,
  ...rest
}: {
  viewer: SessionUser;
  params: Record<string, string | string[] | undefined>;
  rungs: readonly PerformanceRung[];
} & Pick<
  PerformanceViewProps,
  | 'title'
  | 'description'
  | 'basePath'
  | 'rungTabs'
  | 'totalsLabel'
  | 'emptyTitle'
  | 'emptyDescription'
  | 'recordsBasePath'
  | 'children'
>) {
  const parsed = parsePerformanceParams(params, rungs);
  const period = await resolvePeriodFilter(parsed.period);
  const view = { ...parsed, period: period.code };

  // The manager's own code, or null for an admin — an admin is not a competitor
  // in the ranking and has the whole table in front of them anyway.
  const peerRung = viewer.role === 'tl' ? 'tl' : viewer.role === 'acm' ? 'acm' : null;
  const peerCode = viewer.role === 'tl' ? viewer.tlCode : viewer.role === 'acm' ? viewer.acmCode : null;

  let report: PerformanceReport;
  let standing: PeerStanding | null = null;
  let reasons: OutcomeReason[] = [];
  try {
    [report, standing, reasons] = await Promise.all([
      loadPerformance({ viewer, rung: view.rung, periodId: period.periodId }),
      peerRung && peerCode
        ? loadManagerStanding(peerRung, peerCode, period.periodId)
        : Promise.resolve(null),
      loadOutcomeReasons(viewer, period.periodId),
    ]);
  } catch (error) {
    // The only refusal reachable here is a manager account whose roster code was
    // never filled in. That is an administrator's fix, not a crash — spelled out
    // rather than left as a digest on an error screen.
    if (error instanceof AuthzError) {
      return (
        <section>
          <PageHeader title={rest.title} description={rest.description} />
          <Alert tone="danger" title="This account has no book to report on">
            Your login carries no {viewer.role === 'acm' ? 'ACM' : viewer.role === 'tl' ? 'TL' : 'SM'}{' '}
            code, so there is no team to measure. An administrator can add one on the People screen;
            until then this page has nothing it is allowed to show.
          </Alert>
        </section>
      );
    }
    throw error;
  }

  return (
    <PerformanceView
      {...rest}
      report={report}
      view={view}
      rungs={rungs}
      periods={period.options}
      standing={standing}
      reasons={reasons}
    />
  );
}

export type PeriodOption = { code: string; label: string; status: string };

export type PerformanceViewProps = {
  title: string;
  description: string;
  /** The route these links go back to, e.g. `/tl/performance`. */
  basePath: string;
  report: PerformanceReport;
  view: PerformanceParams;
  /** Rungs this role may switch between. One entry hides the switcher. */
  rungs: readonly PerformanceRung[];
  /** Per-role wording for a rung tab, e.g. `{ sm: 'My reps' }`. */
  rungTabs?: Partial<Record<PerformanceRung, string>>;
  periods: readonly PeriodOption[];
  /** What the stat-card row is the total OF — "My team", "Everything imported". */
  totalsLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  /**
   * The record grid these rows drill into, e.g. `/acm/records`. Omit and the
   * rows render as plain text.
   *
   * This page answers "who issued how much"; the question it always provokes is
   * "issued WHAT", and until this existed there was no way to get from a team
   * leader's row to that team leader's 93 policies. The link carries `?tlId=` or
   * `?smId=`, both of which `recordWhere` ANDs with the reader's own scope — so
   * the link cannot reach further than the page the reader is already on.
   */
  recordsBasePath?: string;
  /** Rendered above the table — a cluster note, a warning, a link out. */
  children?: React.ReactNode;
  /** Where this manager's own book sits among their peers. Null for an admin. */
  standing?: PeerStanding | null;
  /** The `status_2` behind each outcome — why the pending are pending. */
  reasons?: readonly OutcomeReason[];
};

export function PerformanceView(props: PerformanceViewProps) {
  const { report, view, basePath, periods, totalsLabel } = props;
  const { totals } = report;
  const standing = props.standing ?? null;
  const reasons = props.reasons ?? [];

  const rows = sortPerformanceRows(report.rows, totals, view.sort, view.dir);
  const selectedPeriod = periods.find((p) => p.code === view.period);
  // A code in the URL that names no period is a stale bookmark, not an error
  // worth a crash screen — the report falls back to every period and says so.
  const unknownPeriod = view.period !== '' && view.period !== 'all' && !selectedPeriod;

  const href = (patch: Partial<PerformanceParams>) => {
    const merged = { ...view, ...patch };
    const query = new URLSearchParams({
      rung: merged.rung,
      sort: merged.sort,
      dir: merged.dir,
    });
    if (merged.period) query.set('period', merged.period);
    return `${basePath}?${query.toString()}`;
  };

  return (
    <section>
      <PageHeader title={props.title} description={props.description} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {props.rungs.length > 1 ? (
          // Links, not tabs with state: each rung is a different query and
          // therefore a different URL somebody can send to their manager.
          <nav aria-label="Group by" className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
              Group by
            </span>
            {props.rungs.map((rung) => (
              <Link
                key={rung}
                href={href({ rung })}
                aria-current={rung === view.rung ? 'page' : undefined}
                className={buttonClass(rung === view.rung ? 'primary' : 'secondary')}
              >
                {props.rungTabs?.[rung] ?? RUNG_LABELS[rung]}
              </Link>
            ))}
          </nav>
        ) : (
          <span />
        )}

        {/* A GET form, so the filter is bookmarkable and needs no JavaScript.
            The hidden fields carry the rest of the view across the submit —
            without them, changing the month would silently reset the sort. */}
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="rung" value={view.rung} />
          <input type="hidden" name="sort" value={view.sort} />
          <input type="hidden" name="dir" value={view.dir} />
          <label
            htmlFor="performance-period"
            className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500"
          >
            Period
          </label>
          <select
            id="performance-period"
            name="period"
            defaultValue={view.period || 'all'}
            className="rounded-md border border-slate-300 bg-white px-2.5 py-[5px] text-[12px] text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
          >
            <option value="all">All periods</option>
            {periods.map((option) => (
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
          <Alert tone="warning" title={`No period is coded ${view.period}`}>
            The link you followed names a month this portal does not hold. Everything below covers
            every period instead — pick one from the filter to narrow it.
          </Alert>
        </div>
      ) : null}

      {totals.unclassified > 0 ? (
        <div className="mb-4">
          <Alert
            tone="warning"
            title={`${n(totals.unclassified)} ${
              totals.unclassified === 1 ? 'application carries' : 'applications carry'
            } a status this portal does not recognise`}
          >
            Issued, rejected and pending always add up to logins, so these are counted as pending —
            the reading that cannot overstate production. They are none of ISSUED, PENDING or
            REJECTED, which means the source file has started using a fourth value, and the
            issuance percentage below is understated until somebody says what it means.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Logins" value={n(totals.logins)} hint={totalsLabel} />
        <StatCard
          label="Issued"
          value={n(totals.issued)}
          hint={`${formatPercent(issuanceRate(totals))} issuance`}
          tone={totals.issued > 0 ? 'success' : 'default'}
        />
        <StatCard
          label="Rejected"
          value={n(totals.rejected)}
          hint={`${formatPercent(rejectionRate(totals))} — declined, postponed or cancelled`}
          tone={totals.rejected > 0 ? 'danger' : 'default'}
        />
        <StatCard label="Pending" value={n(totals.pending)} hint="Still in flight" />
        <StatCard label="ANP" value={formatMoney(totals.anp)} hint={`FP ${formatMoney(totals.fp)}`} />
      </div>

      {/* The invariant, on screen. Every one of these is read off Status 2, and
          a reader who adds the three cards up is entitled to get the first one. */}
      <p className="mt-2 text-[11px] text-slate-500">
        {n(totals.issued)} issued + {n(totals.rejected)} rejected + {n(totals.pending)} pending ={' '}
        {n(totals.logins)} logins. The outcome is{' '}
        <span className="font-mono text-[11px] text-slate-700">Status</span>, corrected by{' '}
        <span className="font-mono text-[11px] text-slate-700">Status 2</span> in the two cases the
        sheet leaves standing at issued: an application whose Status 2 is APPROVED is still pending,
        and one whose Status 2 is FREELOOK CANCEL was cancelled inside the free-look window and is
        not production.
      </p>

      {standing ? (
        <div className="mt-4">
          <PeerComparison standing={standing} />
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="mt-4">
          <OutcomeReasons reasons={reasons} totals={totals} />
        </div>
      ) : null}

      {props.children ? <div className="mt-4">{props.children}</div> : null}

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState title={props.emptyTitle} description={props.emptyDescription} />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader view={view} href={href} column="name" className="text-left">
                  {RUNG_LABELS[view.rung]}
                </SortHeader>
                <SortHeader view={view} href={href} column="logins" numeric>
                  Logins
                </SortHeader>
                <SortHeader view={view} href={href} column="share">
                  Login share
                </SortHeader>
                <SortHeader view={view} href={href} column="issued" numeric>
                  Issued
                </SortHeader>
                <SortHeader view={view} href={href} column="issuance">
                  Issuance
                </SortHeader>
                <SortHeader view={view} href={href} column="rejected" numeric>
                  Rejected
                </SortHeader>
                <SortHeader view={view} href={href} column="rejection">
                  Rejection
                </SortHeader>
                <SortHeader view={view} href={href} column="pending" numeric>
                  Pending
                </SortHeader>
                <SortHeader view={view} href={href} column="anp" numeric>
                  ANP
                </SortHeader>
                <SortHeader view={view} href={href} column="fp" numeric>
                  FP
                </SortHeader>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <PerformanceRowCells
                  key={row.code ?? 'unplaced'}
                  row={row}
                  totals={totals}
                  href={drillHref(props.recordsBasePath, report.rung, row.code)}
                />
              ))}
            </tbody>
          </Table>
        )}
      </div>

      {report.placeholders.length > 0 ? (
        <div className="mt-4">
          <Placeholders rows={report.placeholders} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The record grid a row drills into, or null when there is nothing to link to.
 *
 * Null for the ACM rung — the record filters carry no `acmId`, and a link that
 * silently ignored half its query string would be worse than plain text. Null
 * for the unplaced bucket too: `code === null` is the absence of a code, so
 * there is no team or rep to narrow to.
 */
function drillHref(
  basePath: string | undefined,
  rung: PerformanceRung,
  code: string | null,
): string | null {
  if (!basePath || code === null) return null;
  const key = rung === 'tl' ? 'tlId' : rung === 'sm' ? 'smId' : null;
  return key ? `${basePath}?${key}=${encodeURIComponent(code)}` : null;
}

/** One rep, team leader or area manager. */
function PerformanceRowCells({
  row,
  totals,
  href,
}: {
  row: PerformanceRow;
  totals: PerformanceReport['totals'];
  /** Where this row's policies live, or null to render the label as plain text. */
  href: string | null;
}) {
  const label = (
    <>
      {/* An identifier is text: monospaced, left-aligned, never a number. */}
      <span className="font-mono text-[12px] text-slate-900">{row.code}</span>
      {row.name ? <span className="ml-2 text-slate-700">{row.name}</span> : null}
    </>
  );

  return (
    <tr>
      <Td>
        {row.code === null ? (
          <span className="text-amber-800">
            Not placed on the roster
            <span className="ml-1.5 text-[11px] text-slate-500">
              — no Manpower row names these policies
            </span>
          </span>
        ) : href ? (
          <Link
            href={href}
            className="underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
            title={`Show every application logged by ${row.name ?? row.code}`}
          >
            {label}
          </Link>
        ) : (
          label
        )}
      </Td>
      <Td className="text-right tabular-nums">{n(row.logins)}</Td>
      <Td className="min-w-[7.5rem]">
        <Meter value={loginShare(row, totals)} />
      </Td>
      <Td className="text-right tabular-nums">{n(row.issued)}</Td>
      <Td className="min-w-[7.5rem]">
        <Meter value={issuanceRate(row)} tone="positive" />
      </Td>
      <Td className="text-right tabular-nums">{n(row.rejected)}</Td>
      <Td className="min-w-[7.5rem]">
        <Meter value={rejectionRate(row)} tone="negative" />
      </Td>
      <Td className="text-right tabular-nums">{n(row.pending)}</Td>
      <Td className="text-right tabular-nums">{formatMoney(row.anp)}</Td>
      <Td className="text-right tabular-nums">{formatMoney(row.fp)}</Td>
    </tr>
  );
}

const RANK_SUBJECT: Record<PerformanceRung, { own: string; peers: string; field: string }> = {
  // A rep is ranked inside their own team, so the pooled rate beside the median
  // is the TEAM's, not the company's. Saying "across the company" there would be
  // a different number under the same words.
  sm: { own: 'You', peers: 'the reps on your team', field: 'across your team' },
  tl: { own: 'Your team', peers: 'every team in the company', field: 'across the company' },
  acm: { own: 'Your cluster', peers: 'every cluster in the company', field: 'across the company' },
};

/** 1st, 2nd, 3rd — a rank reads as a rank, not as a quantity. */
function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
  return `${value}${suffix}`;
}

/**
 * Where this book sits among its peers — a position, never a leaderboard.
 *
 * The product owner asked how their team compares with the other teams, and the
 * honest answer to that is a rank and a middle. It is deliberately NOT a list of
 * the other teams: `loadManagerStanding` reduces the peer rows to these four
 * numbers before they leave the query, so this card cannot name anybody even if
 * a later edit wanted it to.
 *
 * Median and pooled average are both here because they answer different
 * questions — the median is the typical team, the average is the company's own
 * issuance rate, and a team above one and below the other is a real and
 * informative position to be in.
 */
export function PeerComparison({ standing }: { standing: PeerStanding }) {
  const subject = RANK_SUBJECT[standing.rung];
  const versus = standing.median === null || standing.rate === null
    ? null
    : (standing.rate - standing.median) * 100;

  return (
    <Card
      title={`${subject.own} against ${subject.peers}`}
      description="Ranked on issuance — issued over logins. Nobody else's figures are shown, only where you sit among them."
    >
      <div className="-m-4 grid gap-px bg-slate-100 sm:grid-cols-3">
        <div className="bg-white p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
            Rank
          </p>
          <p className="mt-1 text-[25px] leading-tight font-semibold tracking-[-0.02em] tabular-nums text-slate-900">
            {standing.rank === null ? '—' : ordinal(standing.rank)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {standing.rank === null
              ? 'nothing logged, so there is no position to hold'
              : `of ${n(standing.peers)} with business this period`}
          </p>
        </div>
        <div className="bg-white p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
            My issuance
          </p>
          <p className="mt-1 text-[25px] leading-tight font-semibold tracking-[-0.02em] tabular-nums text-slate-900">
            {formatPercent(standing.rate)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            {versus === null ? (
              'no median to compare against'
            ) : (
              <>
                {Math.abs(versus).toFixed(1)} points{' '}
                {versus === 0 ? 'level with' : versus > 0 ? 'above' : 'below'} the median
                <span className="ml-1.5">
                  <Badge tone={versus >= 0 ? 'success' : 'warning'}>
                    {versus >= 0 ? 'ahead' : 'behind'}
                  </Badge>
                </span>
              </>
            )}
          </p>
        </div>
        <div className="bg-white p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
            The field
          </p>
          <p className="mt-1 text-[25px] leading-tight font-semibold tracking-[-0.02em] tabular-nums text-slate-900">
            {formatPercent(standing.median)}
          </p>
          <p className="mt-1 text-[11px] text-slate-500">
            median · {formatPercent(standing.average)} {subject.field}
          </p>
        </div>
      </div>
    </Card>
  );
}

const OUTCOME_LABEL = { issued: 'Issued', pending: 'Pending', rejected: 'Rejected' } as const;

/**
 * What is behind each outcome — the answer to "why is this one stuck".
 *
 * Three statuses is the vocabulary the business uses, but a decline, a
 * postponement and a free-look cancellation are three different problems with
 * three different remedies, and folding them into one REJECTED count without
 * this panel would lose that. Pending is the same in reverse: `FR-AR` means the
 * file is with underwriting and `C_OFFER` means the customer has an offer to
 * accept, and those are different phone calls to make. Even ISSUED has a reason
 * worth reading — a `PRE-UNITIZE` policy is issued with its units not yet
 * allotted.
 *
 * A blank Status 2 is the common case on a pending row — 297 of 375 in the June
 * file — and renders as an em dash. It is the absence of a reason, and printing
 * anything else there would be inventing one.
 */
export function OutcomeReasons({
  reasons,
  totals,
}: {
  reasons: readonly OutcomeReason[];
  totals: PerformanceMetrics;
}) {
  const shown = OUTCOMES.filter((outcome) => reasons.some((row) => row.outcome === outcome));
  if (shown.length === 0) return null;

  return (
    <Card
      title="Why they sit where they do"
      description="The Status 2 behind each outcome — Rejected · PSTPNE6 is a postponement, Pending · C_OFFER is an offer with the customer. The outcome is one count; the remedy is not."
    >
      <div className="-m-4 grid gap-px bg-slate-100 sm:grid-cols-3">
        {shown.map((outcome) => {
          const rows = reasons.filter((row) => row.outcome === outcome);
          const total = totals[outcome];

          return (
            <div key={outcome} className="bg-white p-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500">
                {OUTCOME_LABEL[outcome]} · {n(total)}
              </p>
              <ul className="mt-2 space-y-1">
                {rows.map((row) => (
                  <li
                    key={row.reason ?? 'blank'}
                    className="flex items-baseline gap-2 text-[12px] text-slate-700"
                  >
                    {row.reason === null ? (
                      <span className="text-slate-400" title="The sheet records no reason">
                        —
                      </span>
                    ) : (
                      <span className="font-mono text-[11px] text-slate-900">{row.reason}</span>
                    )}
                    <span className="ml-auto tabular-nums">{n(row.count)}</span>
                    <span className="w-[3.5rem] shrink-0 text-right tabular-nums text-slate-500">
                      {formatPercent(total > 0 ? row.count / total : null)}
                    </span>
                  </li>
                ))}
              </ul>
              {rows.some((row) => row.reason === null) ? (
                <p className="mt-2 text-[11px] text-slate-500">
                  &mdash; is an application whose Status 2 the sheet left blank: pending with no
                  reason recorded.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * The placeholder buckets, kept out of the ranking and kept on the screen.
 *
 * `DIY` and `111222-UN` are not people, so ranking them against reps would be
 * meaningless — but dropping their policies would mean the figures on this page
 * no longer reconcile against the workbook, which is the harder failure to spot.
 * They are in the totals above and itemised here.
 */
function Placeholders({ rows }: { rows: readonly PerformanceRow[] }) {
  return (
    <Card
      title="Business with nobody attached"
      description="Counted in the totals above, kept out of the ranking — these codes are buckets in the source file, not people."
    >
      <ul className="-m-4 divide-y divide-slate-100">
        {rows.map((row) => (
          <li
            key={row.code ?? 'placeholder'}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-[9px]"
          >
            <span className="font-mono text-[12px] text-slate-900">{row.code ?? 'DIY'}</span>
            <Badge tone="neutral">Placeholder</Badge>
            <span className="ml-auto text-[12px] tabular-nums text-slate-700">
              {n(row.logins)} logins · {n(row.issued)} issued ·{' '}
              {formatPercent(issuanceRate(row))} issuance · ANP {formatMoney(row.anp)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * A column header that sorts.
 *
 * `aria-sort` on the cell and a caret in the label, because a caret alone is
 * colourless punctuation a screen reader reads as nothing. Clicking the column
 * already sorted flips the direction; clicking any other starts it descending,
 * which for every column here means "biggest first" — the question the page is
 * open to answer.
 */
function SortHeader({
  view,
  href,
  column,
  numeric,
  className,
  children,
}: {
  view: PerformanceParams;
  href: (patch: Partial<PerformanceParams>) => string;
  column: PerformanceSort;
  numeric?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const active = view.sort === column;
  const next = active && view.dir === 'desc' ? 'asc' : 'desc';

  return (
    <Th
      aria-sort={active ? (view.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cx(numeric ? 'text-right' : null, className)}
    >
      <Link
        href={href({ sort: column, dir: next })}
        className={cx(
          'inline-flex items-center gap-1 no-underline hover:text-slate-900',
          active ? 'text-slate-900' : 'text-slate-600',
        )}
      >
        {children}
        <span aria-hidden="true" className={active ? 'text-slate-900' : 'text-slate-300'}>
          {active ? (view.dir === 'asc' ? '▲' : '▼') : '▾'}
        </span>
      </Link>
    </Th>
  );
}
