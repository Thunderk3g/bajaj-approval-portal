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
  formatPercent,
  issuanceRate,
  loadPerformance,
  loginShare,
  parsePerformanceParams,
  refusalRate,
  resolvePeriodFilter,
  sortPerformanceRows,
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

  let report: PerformanceReport;
  try {
    report = await loadPerformance({ viewer, rung: view.rung, periodId: period.periodId });
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

  return <PerformanceView {...rest} report={report} view={view} rungs={rungs} periods={period.options} />;
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
};

export function PerformanceView(props: PerformanceViewProps) {
  const { report, view, basePath, periods, totalsLabel } = props;
  const { totals } = report;

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
            Issued, refused and pending always add up to logins, so these are counted as pending.
            They are neither ISSUED nor REJECTED nor PENDING, which means the source file has
            started using a fourth value — the issuance and refusal percentages below are
            understated until somebody says what it means.
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
          label="Refused"
          value={n(totals.refused)}
          hint={`${formatPercent(refusalRate(totals))} refusal`}
          tone={totals.refused > 0 ? 'danger' : 'default'}
        />
        <StatCard label="Pending" value={n(totals.pending)} hint="Neither issued nor refused" />
        <StatCard label="ANP" value={formatMoney(totals.anp)} hint={`FP ${formatMoney(totals.fp)}`} />
      </div>

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
                <SortHeader view={view} href={href} column="refused" numeric>
                  Refused
                </SortHeader>
                <SortHeader view={view} href={href} column="refusal">
                  Refusal
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
      <Td className="text-right tabular-nums">{n(row.refused)}</Td>
      <Td className="min-w-[7.5rem]">
        <Meter value={refusalRate(row)} tone="negative" />
      </Td>
      <Td className="text-right tabular-nums">{n(row.pending)}</Td>
      <Td className="text-right tabular-nums">{formatMoney(row.anp)}</Td>
      <Td className="text-right tabular-nums">{formatMoney(row.fp)}</Td>
    </tr>
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
