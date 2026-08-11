import { Alert, Card, PageHeader, buttonClass } from '@/components/ui';
import { HierarchyBubbles } from '@/app/admin/uploads/_components/hierarchy-bubbles';
import { AuthzError } from '@/lib/auth/errors';
import type { SessionUser } from '@/lib/auth/rbac';
import { resolvePeriodFilter } from '@/lib/dashboard/performance';
import { loadCoverage, type BatchCoverage } from '@/lib/hierarchy/coverage';
import { listBatchOptions } from '@/lib/records/query';

/**
 * The bubble map on its own route, scoped to whoever is looking.
 *
 * The chart itself already existed and was only ever reachable inside one
 * committed upload's detail page — which meant the one view that answers "did
 * this month's business land where the org chart says it should" could not be
 * opened without first remembering which batch to open. Same renderer, same
 * loader, a route of its own and a scope instead of a batch id.
 *
 * Server component throughout: `<details>` does the expansion natively and the
 * filters are a GET form, so nothing here ships to the browser.
 */
export async function MappingScreen({
  viewer,
  params,
  title,
  description,
  /** The batch picker is admin-only — a manager reconciles a month, not a file. */
  batchFilter = false,
}: {
  viewer: SessionUser;
  params: Record<string, string | string[] | undefined>;
  title: string;
  description: string;
  batchFilter?: boolean;
}) {
  const one = (key: string): string => {
    const value = params[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first ?? '';
  };

  const requestedPeriod = one('period');
  const requestedBatch = one('batch');
  const period = await resolvePeriodFilter(requestedPeriod);

  const batches = batchFilter ? await listBatchOptions(viewer) : [];
  const batchId = batches.some((batch) => batch.id === requestedBatch) ? requestedBatch : null;

  let coverage: BatchCoverage;
  try {
    coverage = await loadCoverage({ viewer, periodId: period.periodId, batchId });
  } catch (error) {
    if (error instanceof AuthzError) {
      return (
        <section>
          <PageHeader title={title} description={description} />
          <Alert tone="danger" title="This account has no book to map">
            Your login carries no roster code, so there is no team whose policies could be placed on
            the hierarchy. An administrator can add one on the People screen.
          </Alert>
        </section>
      );
    }
    throw error;
  }

  const unknownPeriod =
    requestedPeriod !== '' &&
    requestedPeriod !== 'all' &&
    !period.options.some((option) => option.code === requestedPeriod);

  return (
    <section>
      <PageHeader title={title} description={description} />

      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <label
            htmlFor="mapping-period"
            className="text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500"
          >
            Period
          </label>
          <select
            id="mapping-period"
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

          {batchFilter ? (
            <>
              <label
                htmlFor="mapping-batch"
                className="ml-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-slate-500"
              >
                Upload
              </label>
              <select
                id="mapping-batch"
                name="batch"
                defaultValue={batchId ?? ''}
                className="max-w-[16rem] rounded-md border border-slate-300 bg-white px-2.5 py-[5px] text-[12px] text-slate-900 outline-none focus:border-slate-500 focus:ring-1 focus:ring-slate-500"
              >
                <option value="">Every upload</option>
                {batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.label}
                  </option>
                ))}
              </select>
            </>
          ) : null}

          <button type="submit" className={buttonClass('secondary')}>
            Apply
          </button>
        </form>
      </div>

      {unknownPeriod ? (
        <div className="mb-4">
          <Alert tone="warning" title={`No period is coded ${requestedPeriod}`}>
            The link you followed names a month the portal does not hold, so the map below covers
            every period.
          </Alert>
        </div>
      ) : null}

      <Card
        title="Policies against the hierarchy"
        description="Area manager, then team leader, then rep. Bubble area is the policy count, so a bubble twice the width is four times the business."
      >
        <HierarchyBubbles
          coverage={coverage}
          empty={{
            title: 'Nothing to place on the hierarchy yet',
            description:
              'Two commits fill this in, in this order: a Manpower sheet, which is the only thing that puts a rep under a team leader and that team leader under an area manager, and then a business dashboard, whose policies are what the bubbles are made of.',
          }}
          unmapped={{
            title: 'No policy here reaches a rep on the roster',
            description:
              'Every code in scope is either a placeholder or absent from the Manpower sheet, so nothing can be attributed to a person. Import an up-to-date roster and the chart fills in — the codes are listed below.',
          }}
        />
      </Card>
    </section>
  );
}
