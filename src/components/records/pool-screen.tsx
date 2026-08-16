import Link from 'next/link';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  LinkButton,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { FilterBar, FilterField } from '@/components/approvals/filter-bar';
import type { SessionUser } from '@/lib/auth/rbac';
import { formatDate, orDash } from '@/lib/format';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import {
  bucketLabel,
  hasActivePoolFilters,
  listPool,
  parsePoolFilters,
  poolSummary,
  type PoolRow,
  type SearchParams,
} from '@/lib/records/pool';
import { isPlaceholderCode } from '@/lib/roster/placeholders';

/**
 * The unassigned pool, written once and rendered under /sales, /tl and /acm.
 *
 * The three do the same job at different widths — find business sitting on a
 * bucket code and claim it — so the screen is shared and only the wording
 * differs. Three copies would be three places to fix the day the table gains a
 * column, and the claim rules are the one thing that must not drift between
 * rungs.
 *
 * There is no action on this page beyond a LINK. Claiming is a MAPPING /
 * CLAIM_IN correction through the existing form, deep-linked with the
 * application number prefilled, so the pool adds a way to FIND a record and
 * nothing at all to the way one changes hands.
 */

type Role = 'sales' | 'tl' | 'acm';

const WORDS: Record<Role, { description: string; claimHint: string }> = {
  sales: {
    description:
      'Policies the source data credits to no rep — digital-channel and unassigned business. Anyone can see this list; claiming one raises a mapping request against your own SM ID for a verifier and an approver to decide.',
    claimHint: 'Claims land on your own SM ID',
  },
  tl: {
    description:
      'Policies the source data credits to no rep — digital-channel and unassigned business. Claiming one raises a mapping request on behalf of a rep in your team; you choose which on the next screen.',
    claimHint: 'Claims land on a rep you name',
  },
  acm: {
    description:
      'Policies the source data credits to no rep — digital-channel and unassigned business. Claiming one raises a mapping request on behalf of a rep in your teams; you choose which on the next screen.',
    claimHint: 'Claims land on a rep you name',
  },
};

export async function PoolScreen({
  viewer,
  role,
  searchParams,
}: {
  viewer: SessionUser;
  role: Role;
  searchParams: SearchParams;
}) {
  const { filters, period } = await parsePoolFilters(searchParams);
  const page = parsePageParams(searchParams);

  const [pool, summary] = await Promise.all([
    listPool(viewer, filters, page),
    poolSummary(viewer),
  ]);

  const words = WORDS[role];
  const filtered = hasActivePoolFilters(filters);
  const base = `/${role}/pool`;

  return (
    <section className="space-y-4">
      <PageHeader title="Unassigned pool" description={words.description} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="In the pool"
          value={summary.total.toLocaleString('en-IN')}
          hint="Credited to no rep"
        />
        <StatCard
          label="Claimable now"
          value={summary.claimable.toLocaleString('en-IN')}
          hint={words.claimHint}
        />
        <StatCard
          label="Claim in flight"
          value={summary.claimed.toLocaleString('en-IN')}
          hint={summary.claimed === 0 ? 'Nobody has claimed one yet' : 'Awaiting a decision'}
          tone={summary.claimed > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label="Claimed by you"
          value={summary.mine.toLocaleString('en-IN')}
          hint={summary.mine === 0 ? 'You have none in flight' : 'Raised by or for you'}
          href={`/${role}/requests`}
        />
      </div>

      <FilterBar>
        <FilterField label="Search">
          <Input
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="Application, client or location"
          />
        </FilterField>

        <FilterField label="Cycle">
          <Select name="period" defaultValue={period.code}>
            <option value="all">All cycles</option>
            {period.options.map((option) => (
              <option key={option.id} value={option.code}>
                {option.label}
                {option.status === 'OPEN' ? ' (open)' : ''}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Issued from">
          <Input type="date" name="issuedFrom" defaultValue={filters.issuedFrom ?? ''} />
        </FilterField>

        <FilterField label="Issued to">
          <Input type="date" name="issuedTo" defaultValue={filters.issuedTo ?? ''} />
        </FilterField>

        <FilterField label="Per page">
          <Select name="pageSize" defaultValue={String(page.pageSize)}>
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </FilterField>

        <Button type="submit" variant="secondary">
          Apply
        </Button>
        {/* A link rather than a reset button: resetting the controls would leave
            the URL — and therefore the rows — untouched, which reads as a Clear
            that did nothing. */}
        {filtered ? (
          <LinkButton href={base} variant="ghost">
            Clear
          </LinkButton>
        ) : null}
      </FilterBar>

      {pool.rows.length === 0 ? (
        <EmptyState
          title="Nothing in the pool matches"
          description={
            filtered
              ? 'Clear a filter or widen the search term. The pool is the same for everybody, so an empty result here means no such unclaimed record exists — not that one is hidden from you.'
              : 'Every policy in this cycle is credited to a rep. Nothing arrived on a bucket code, so there is nothing to claim.'
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Application</Th>
              <Th>Client</Th>
              <Th>Product</Th>
              <Th>Issued</Th>
              <Th>Location</Th>
              <Th>Source</Th>
              <Th>Status</Th>
              <Th>Claim</Th>
            </tr>
          </thead>
          <tbody>
            {pool.rows.map((row) => (
              <tr key={row.appsNo} className="hover:bg-slate-50">
                <Td className="font-mono text-xs font-medium text-slate-900">{row.appsNo}</Td>
                <Td>{orDash(row.clientName)}</Td>
                <Td>{orDash(row.productName)}</Td>
                <Td className="whitespace-nowrap">{formatDate(row.issuedDate)}</Td>
                {/* The workbook stamps the bucket code into Location as well —
                    all 92 live DIY rows carry `Location = DIY` — so the raw
                    value would print the code the Source column exists to
                    translate. Masked rather than dropped: the column is right
                    the day a bucket row carries a real branch. */}
                <Td>{orDash(isPlaceholderCode(row.location) ? null : row.location)}</Td>
                {/* The bucket code itself is never printed: `DIY` and
                    `111222-UN` are artefacts of the workbook, and showing one
                    invites somebody to paste it into a filter as a rep. */}
                <Td>
                  <Badge tone="neutral">{bucketLabel(row.bucket)}</Badge>
                </Td>
                <Td>
                  <StatusBadge status={row.status} />
                </Td>
                <Td>
                  <ClaimCell row={row} role={role} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Pagination
        page={pool.page}
        pageCount={pool.pageCount}
        totalRows={pool.total}
        hrefFor={(next) => `${base}${buildQuery(searchParams, { page: next })}`}
      />
    </section>
  );
}

/**
 * The one interactive cell, in four states.
 *
 * Somebody else's claim names nobody. The pool is visible to every rep in the
 * company, so "claimed by <name>" would turn a worklist into a directory of who
 * is competing for which sale — and it buys the reader nothing, since the answer
 * either way is "not this one".
 */
function ClaimCell({ row, role }: { row: PoolRow; role: Role }) {
  if (row.pendingClaim) {
    if (row.pendingClaim.mine && row.pendingClaim.requestId) {
      return (
        // next/link, not a bare anchor: `basePath` is applied to Link and not to
        // a plain href, and on the VM the portal is served under /reconciliation.
        <Link
          href={`/${role}/requests/${row.pendingClaim.requestId}`}
          className="no-underline"
          aria-label={`Your claim on application ${row.appsNo}`}
        >
          <Badge tone="info">Your claim</Badge>
        </Link>
      );
    }
    return <Badge tone="warning">Claim pending</Badge>;
  }

  if (!row.periodOpen) {
    // The insert would be refused by the period trigger, so offering the button
    // would be offering a form that cannot be submitted.
    return <span className="text-slate-500">Month closed</span>;
  }

  return (
    <LinkButton
      href={`/${role}/requests/new?category=MAPPING&direction=CLAIM_IN&appsNo=${encodeURIComponent(row.appsNo)}`}
      variant="secondary"
      className="px-2.5 py-1"
      aria-label={`Claim application ${row.appsNo}`}
    >
      Claim
    </LinkButton>
  );
}
