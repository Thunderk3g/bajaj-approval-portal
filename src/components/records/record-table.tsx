import Link from 'next/link';
import { EmptyState, StatusBadge, Table, Td, Th, cx } from '@/components/ui';
import { formatDate, formatMoney, orDash } from '@/lib/format';
import { buildQuery } from '@/lib/pagination';
import type { SearchParams, SortDir, SortKey } from '@/lib/records/filters';
import type { RecordListRow } from '@/lib/records/query';
import { GapBadges } from './gap-badges';

/**
 * Columns whose first click should sort newest / largest first.
 *
 * Ascending is the right default for a name or an identifier and the wrong one
 * for a date or an amount — nobody clicking "Issued date" wants the oldest
 * application in the book.
 */
const DESC_FIRST = new Set<SortKey>(['loginDate', 'issuedDate', 'fp', 'anp', 'updatedAt']);

function SortHeader({
  label,
  column,
  sort,
  dir,
  basePath,
  query,
  className,
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  dir: SortDir;
  basePath: string;
  query: SearchParams;
  className?: string;
}) {
  const active = sort === column;
  const nextDir: SortDir = active
    ? dir === 'asc'
      ? 'desc'
      : 'asc'
    : DESC_FIRST.has(column)
      ? 'desc'
      : 'asc';

  // Sorting resets to page 1: the row that was at offset 150 under the old
  // order is a different row under the new one, so keeping the offset lands the
  // reader somewhere arbitrary.
  const href = `${basePath}${buildQuery(query, { sort: column, dir: nextDir, page: undefined })}`;

  return (
    <Th className={className} aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <Link href={href} className="inline-flex items-center gap-1 hover:text-slate-900">
        {label}
        <span className={cx('text-[10px]', active ? 'text-slate-900' : 'text-slate-300')} aria-hidden="true">
          {active ? (dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </Link>
    </Th>
  );
}

export function RecordTable({
  rows,
  basePath,
  detailBase,
  query,
  sort,
  dir,
  variant,
  tlBySmId,
}: {
  rows: RecordListRow[];
  basePath: string;
  detailBase: string;
  query: SearchParams;
  sort: SortKey;
  dir: SortDir;
  /**
   * `manager` is the TL/ACM grid: the rep column an admin gets, plus the gap
   * column a rep gets. A manager needs both — whose policy it is, and what is
   * missing on it — because their screen is the team's worklist, not a ledger.
   */
  variant: 'admin' | 'sales' | 'manager';
  /**
   * Effective TL per SM_ID. Supplied by the ACM view only, and its presence is
   * what renders the Team leader column — `docs/ui-flows.md` §7 gives the ACM
   * that extra column because their view spans several teams and "which TL is
   * this rep under" is the question the view exists to answer. A TL's own view
   * would render one repeated value, so it passes nothing.
   */
  tlBySmId?: ReadonlyMap<string, string | null>;
}) {
  const showRep = variant === 'admin' || variant === 'manager';
  const showGaps = variant === 'sales' || variant === 'manager';
  const showTl = variant === 'manager' && tlBySmId !== undefined;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No records match these filters"
        description="Clear a filter or widen the search term. An empty result here means no matching record exists in your scope, not that one is hidden."
      />
    );
  }

  const header = { sort, dir, basePath, query };

  return (
    <Table>
      <thead>
        <tr>
          <SortHeader label="Apps No" column="appsNo" {...header} />
          {/* The rep's worklist is the gap column, so it comes before the
              commercial detail rather than after it — section 6.4. */}
          {showGaps ? <Th>Missing</Th> : null}
          <SortHeader label="Policy No" column="policyNo" {...header} />
          <SortHeader label="Client" column="clientName" {...header} />
          {showRep ? <SortHeader label="SM" column="smId" {...header} /> : null}
          {showTl ? <Th>Team leader</Th> : null}
          <SortHeader label="Status" column="status" {...header} />
          <SortHeader label="Issued" column="issuedDate" {...header} />
          <SortHeader label="ANP" column="anp" className="text-right" {...header} />
          <SortHeader label="FP" column="fp" className="text-right" {...header} />
          {variant === 'admin' ? <Th>Gaps</Th> : null}
          <Th>Corrections</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="hover:bg-slate-50">
            <Td>
              <Link
                href={`${detailBase}/${encodeURIComponent(row.appsNo)}`}
                className="font-mono text-sm font-medium text-slate-900 underline decoration-slate-300 underline-offset-2 hover:decoration-slate-900"
              >
                {row.appsNo}
              </Link>
            </Td>
            {showGaps ? (
              <Td>
                <GapBadges record={row} emptyLabel="Nothing missing" />
              </Td>
            ) : null}
            <Td className="font-mono text-xs">{orDash(row.policyNo)}</Td>
            <Td>{orDash(row.clientName)}</Td>
            {showRep ? (
              <Td>
                <span className="font-mono text-xs">{row.smId}</span>
                {row.smName ? <span className="block text-xs text-slate-500">{row.smName}</span> : null}
              </Td>
            ) : null}
            {showTl ? (
              <Td className="font-mono text-xs">{orDash(tlBySmId?.get(row.smId) ?? null)}</Td>
            ) : null}
            <Td>
              <StatusBadge status={row.status} />
            </Td>
            <Td className="whitespace-nowrap">{formatDate(row.issuedDate)}</Td>
            {/* Money stays a string end to end — formatMoney groups the digits
                rather than parsing them. */}
            <Td className="text-right tabular-nums">{formatMoney(row.anp)}</Td>
            <Td className="text-right tabular-nums">{formatMoney(row.fp)}</Td>
            {variant === 'admin' ? (
              <Td>
                <GapBadges record={row} />
              </Td>
            ) : null}
            <Td>
              {row.hasCorrections ? (
                <span className="text-xs text-slate-700">Yes</span>
              ) : (
                <span className="text-xs text-slate-400">—</span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
