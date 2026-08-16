import { requireRoleOrRedirect } from '@/lib/auth/page';
import { PageHeader, Pagination, Select, Input, Button, StatCard } from '@/components/ui';
import { FilterBar, FilterField } from '@/components/approvals/filter-bar';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import { listVerifierQueue, verifierQueueCounts } from '@/lib/verification/queries';
import {
  CATEGORY_LABELS,
  CORRECTION_CATEGORIES,
  type SearchParams,
} from '@/lib/approvals/schemas';
import {
  VERIFIER_QUEUE_SCOPES,
  VERIFIER_SCOPE_LABELS,
  parseVerifierQueueFilters,
} from '@/lib/verification/schemas';
import { QueueTable } from '@/components/approvals/queue-table';
import { BulkDecisions } from '@/components/approvals/bulk-decisions';

export const dynamic = 'force-dynamic';

/**
 * The verification queue — 2026-07-28 spec section 3.8.
 *
 * `requireRole` runs here as well as in the layout. The layout gate redirects a
 * browser, but this page is also the target of a direct fetch, and the boundary
 * belongs on the data access rather than on the shell around it.
 */
export default async function VerifierQueuePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const viewer = await requireRoleOrRedirect('verifier');

  const params = await searchParams;
  const filters = parseVerifierQueueFilters(params);
  const page = parsePageParams(params);

  const [queue, counts] = await Promise.all([
    listVerifierQueue(filters, page, viewer),
    verifierQueueCounts(viewer),
  ]);

  return (
    <>
      <PageHeader
        title="Verification queue"
        description="Oldest first. Verifying passes the request to an approver and changes nothing on the record; returning sends it back to the submitter without destroying its history."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="At my step"
          value={counts.mine}
          hint="Yours to verify now, at any rung of the chain"
          tone={counts.mine > 0 ? 'warning' : 'default'}
          href="/verifier/queue?scope=MINE"
        />
        <StatCard
          label="Oldest waiting"
          value={`${counts.oldestDays}d`}
          hint="Days since submission"
          tone={counts.oldestDays >= 7 ? 'danger' : 'default'}
        />
        <StatCard
          label="Past the first check"
          value={counts.verified}
          hint="Somewhere further up the chain — not necessarily with an approver"
          href="/verifier/queue?scope=VERIFIED"
        />
        <StatCard
          label="Returned"
          value={counts.returned}
          hint="Waiting on the submitter"
          href="/verifier/queue?scope=RETURNED"
        />
      </div>

      <FilterBar className="mb-3">
        <FilterField label="Scope">
          <Select name="scope" defaultValue={filters.scope}>
            {VERIFIER_QUEUE_SCOPES.map((s) => (
              <option key={s} value={s}>
                {VERIFIER_SCOPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Category">
          <Select name="category" defaultValue={filters.category ?? ''}>
            <option value="">All categories</option>
            {CORRECTION_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </FilterField>

        <FilterField label="Search">
          <Input
            name="q"
            defaultValue={filters.q ?? ''}
            placeholder="Apps_No, SM_ID, client or submitter"
          />
        </FilterField>

        <FilterField label="Per page">
          <Select name="pageSize" defaultValue={String(page.pageSize)}>
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </FilterField>

        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </FilterBar>

      {/* `homeStatus` still suppresses the redundant PENDING chip on the
          verifier's own rows. Selection, though, is no longer a status question:
          the `MINE` scope is the set of rungs this verifier may decide, and on a
          three-rung chain that includes VERIFIED rows sitting at a second
          verification step — which the old `status === 'PENDING'` filter left
          unselectable and, before the queue itself was fixed, unreachable. */}
      <BulkDecisions
        stage="verifier"
        appsNoById={
          filters.scope === 'MINE'
            ? Object.fromEntries(queue.rows.map((r) => [r.id, r.appsNo]))
            : {}
        }
      >
        <QueueTable
          rows={queue.rows}
          basePath="/verifier"
          homeStatus="PENDING"
          selectable
          decidable={filters.scope === 'MINE'}
        />
      </BulkDecisions>

      <Pagination
        page={queue.page}
        pageCount={queue.pageCount}
        totalRows={queue.total}
        hrefFor={(p) => `/verifier/queue${buildQuery(params, { page: p })}`}
      />
    </>
  );
}
