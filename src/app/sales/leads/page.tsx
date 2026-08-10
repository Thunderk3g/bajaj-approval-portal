import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Button, Input, LinkButton, PageHeader, Pagination, Select, StatCard } from '@/components/ui';
import { FilterBar, FilterField } from '@/components/approvals/filter-bar';
import { LeadTable } from '@/components/leads/lead-table';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import {
  hasActiveLeadFilters,
  leadFilterFormValues,
  parseLeadFilters,
  type SearchParams,
} from '@/lib/leads/filters';
import { leadSummary, listLeads } from '@/lib/leads/queries';

export const metadata: Metadata = {
  title: 'My leads · Sales Data Review Portal',
};

export default async function SalesLeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The layout already checked, but the layout is not the boundary (section
  // 4.1): this page re-reads the session and role itself, so a directly fetched
  // route or a session revoked mid-request still fails closed.
  let viewer: SessionUser;
  try {
    viewer = await requireRole('sales');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const params = await searchParams;
  const filters = parseLeadFilters(params, viewer);
  const page = parsePageParams(params);

  // No sm_code is read from `params` anywhere on this page. Scoping comes from
  // the session through scopedLeadCondition, so a hand-edited ?smCode= reaches
  // the query as nothing at all.
  const [leads, summary] = await Promise.all([
    listLeads(viewer, filters, page),
    leadSummary(viewer),
  ]);
  const values = leadFilterFormValues(filters);
  const filtered = hasActiveLeadFilters(filters);

  return (
    <section className="space-y-4">
      <PageHeader
        title="My leads"
        description="Leads from the monthly Lead Dump attributed to your SM code. This is a read-only view: leads carry no application number, so they cannot be matched to a record or corrected here."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          label="Leads in your name"
          value={summary.total.toLocaleString('en-IN')}
          hint="Everything attributed to your SM code"
        />
        {/* Shown beside the book total rather than alone: a filtered count on
            its own gives no way to tell "you have twelve leads" apart from "your
            filter left twelve of them". */}
        <StatCard
          label="Matching these filters"
          value={leads.total.toLocaleString('en-IN')}
          hint={filtered ? 'Narrowed by the filters below' : 'No filters applied'}
        />
      </div>

      <FilterBar>
        <FilterField label="Search">
          <Input name="q" defaultValue={values.q} placeholder="Lead number or location" />
        </FilterField>

        <FilterField label="Registered from">
          <Input type="date" name="registerFrom" defaultValue={values.registerFrom} />
        </FilterField>

        <FilterField label="Registered to">
          <Input type="date" name="registerTo" defaultValue={values.registerTo} />
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
        {/* A link rather than a reset button: resetting the controls would
            leave the URL — and therefore the rows — untouched, which reads
            as a Clear that did nothing. */}
        {filtered ? (
          <LinkButton href="/sales/leads" variant="ghost">
            Clear
          </LinkButton>
        ) : null}
      </FilterBar>

      <LeadTable rows={leads.rows} variant="sales" />

      <Pagination
        page={leads.page}
        pageCount={leads.pageCount}
        totalRows={leads.total}
        hrefFor={(next) => `/sales/leads${buildQuery(params, { page: next })}`}
      />
    </section>
  );
}
