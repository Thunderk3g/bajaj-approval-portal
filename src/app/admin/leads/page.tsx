import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  Button,
  Card,
  EmptyState,
  Input,
  LinkButton,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { LeadTable } from '@/components/leads/lead-table';
import { AuthzError } from '@/lib/auth/errors';
import { requireRole, type SessionUser } from '@/lib/auth/rbac';
import { formatDate, orDash } from '@/lib/format';
import { buildQuery, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import {
  LEAD_OWNERSHIPS,
  LEAD_OWNERSHIP_LABELS,
  hasActiveLeadFilters,
  leadFilterFormValues,
  parseLeadFilters,
  type SearchParams,
} from '@/lib/leads/filters';
import { leadSummary, listLeads, listOrphanCodes } from '@/lib/leads/queries';

export const metadata: Metadata = {
  title: 'Leads · Sales Data Review Portal',
};

export default async function AdminLeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  let viewer: SessionUser;
  try {
    viewer = await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const params = await searchParams;
  const filters = parseLeadFilters(params, viewer);
  const page = parsePageParams(params);

  const [leads, summary, orphans] = await Promise.all([
    listLeads(viewer, filters, page),
    leadSummary(viewer),
    listOrphanCodes(viewer),
  ]);
  const values = leadFilterFormValues(filters);
  const filtered = hasActiveLeadFilters(filters);

  return (
    <section className="space-y-4">
      <PageHeader
        title="Leads"
        description="Every lead from the monthly Lead Dump. Leads carry no application number, so they are a parallel view rather than part of the reconciliation: nothing here is correctable and nothing here enters the verifier queue."
      />

      <div className="grid gap-3 sm:grid-cols-4">
        <StatCard label="Total leads" value={summary.total.toLocaleString('en-IN')} />
        {/* Warning rather than neutral, and linked rather than merely counted:
            these are real leads nobody has been given, and the only way anyone
            acts on them is by opening the list. */}
        <StatCard
          label="Unassigned"
          value={summary.unassigned.toLocaleString('en-IN')}
          hint="No owner yet — waiting to be given to a rep"
          tone={summary.unassigned > 0 ? 'warning' : 'default'}
          href="/admin/leads?ownership=UNASSIGNED"
        />
        <StatCard
          label="Reps with leads"
          value={summary.reps.toLocaleString('en-IN')}
          hint="Distinct SM codes, sentinel excluded"
        />
        <StatCard
          label="Orphan codes"
          value={summary.orphanCodes.toLocaleString('en-IN')}
          hint="Own leads but absent from the Manpower roster"
          tone={summary.orphanCodes > 0 ? 'danger' : 'success'}
        />
      </div>

      <Card
        title="Orphan SM codes"
        description="Codes attributed leads that the roster has never heard of. The leads are kept and shown; it is the roster that is out of date."
      >
        {orphans.length === 0 ? (
          <EmptyState
            title="Every code owning a lead is on the roster"
            description="Nothing to reconcile from the last ingestion run."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>SM code</Th>
                <Th>Name on the lead</Th>
                <Th className="text-right">Leads</Th>
                <Th>Latest lead</Th>
              </tr>
            </thead>
            <tbody>
              {orphans.map((row) => (
                <tr key={row.smCode} className="hover:bg-slate-50">
                  <Td className="font-mono text-xs font-medium">{row.smCode}</Td>
                  {/* The name the Lead Dump carried, not one from the roster —
                      there is no roster row, and that is the whole finding. */}
                  <Td>{orDash(row.smName)}</Td>
                  <Td className="text-right tabular-nums">{row.leads.toLocaleString('en-IN')}</Td>
                  <Td className="whitespace-nowrap">{formatDate(row.latestRegisterDate)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <form method="get" className="grid gap-3 sm:grid-cols-3">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Search</span>
            <Input
              name="q"
              defaultValue={values.q}
              placeholder="Lead number, rep name or location"
            />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">SM code</span>
            {/* Free text rather than a dropdown: the roster runs to hundreds of
                codes, and a select rebuilt from fifty thousand rows on every
                page load would cost more than the filter is worth. */}
            <Input name="smCode" defaultValue={values.smCode} placeholder="e.g. ICCS427343" />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Ownership</span>
            <Select name="ownership" defaultValue={values.ownership}>
              {LEAD_OWNERSHIPS.map((o) => (
                <option key={o} value={o}>
                  {LEAD_OWNERSHIP_LABELS[o]}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Registered from</span>
            <Input type="date" name="registerFrom" defaultValue={values.registerFrom} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Registered to</span>
            <Input type="date" name="registerTo" defaultValue={values.registerTo} />
          </label>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Per page</span>
            <Select name="pageSize" defaultValue={String(page.pageSize)}>
              {PAGE_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </label>

          <div className="flex items-center gap-2 sm:col-span-3">
            <Button type="submit" variant="secondary">
              Apply filters
            </Button>
            {/* A link rather than a reset button: resetting the controls would
                leave the URL — and therefore the rows — untouched, which reads
                as a Clear that did nothing. */}
            {filtered ? (
              <LinkButton href="/admin/leads" variant="ghost">
                Clear filters
              </LinkButton>
            ) : null}
          </div>
        </form>
      </Card>

      <LeadTable rows={leads.rows} variant="admin" />

      <Pagination
        page={leads.page}
        pageCount={leads.pageCount}
        totalRows={leads.total}
        hrefFor={(next) => `/admin/leads${buildQuery(params, { page: next })}`}
      />
    </section>
  );
}
