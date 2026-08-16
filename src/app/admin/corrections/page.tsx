import type { Metadata } from 'next';
import Link from 'next/link';
import { requireRoleOrRedirect } from '@/lib/auth/page';
import { formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import {
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Pagination,
  PageHeader,
  Select,
  StatusBadge,
  Table,
  Td,
  Th,
} from '@/components/ui';
import {
  CORRECTION_CATEGORIES,
  CORRECTION_STATUSES,
  countCorrections,
  listCorrections,
  listStuckStages,
  parseCorrectionFilters,
} from './query';

export const metadata: Metadata = {
  title: 'Corrections · Sales Data Review Portal',
};

const CATEGORY_LABELS: Record<string, string> = {
  AUTOPAY: 'AutoPay',
  MAPPING: 'Mapping',
  ISSUANCE_DATE: 'Issuance date',
  OTHERS: 'Others',
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function AdminCorrectionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // Spec section 4.1: the page authorizes itself rather than trusting the
  // layout or the middleware to have done it.
  await requireRoleOrRedirect('admin');

  const params = await searchParams;
  const filters = parseCorrectionFilters(params);
  const { page, pageSize, offset } = parsePageParams(params);

  const [total, rows, stuck] = await Promise.all([
    countCorrections(filters),
    listCorrections(filters, { limit: pageSize, offset }),
    listStuckStages(),
  ]);

  return (
    <section>
      <PageHeader
        title="Correction requests"
        description="Every request raised, in any state. Decisions belong to the people the chain routes to — except the steps below, which resolved to nobody and are yours."
      />

      {/* Nothing else in the product lists these, and nobody else can clear
          them. A request whose rung resolved to no person stops here until an
          administrator either fixes the roster placement, provisions the missing
          manager, or decides the step themselves. */}
      {stuck.length > 0 ? (
        <div className="mb-4">
          <Card
            title={`${stuck.length} step${stuck.length === 1 ? '' : 's'} waiting on an administrator`}
            description="These steps resolved to nobody — the roster places the rep under no manager, or names one who has no portal account. Fix the placement on People, or decide the step yourself."
          >
            <ul className="-m-4 divide-y divide-slate-100">
              {stuck.map((stage) => (
                <li
                  key={stage.requestId}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-[9px]"
                >
                  <Link
                    href={`/admin/corrections/${stage.requestId}`}
                    className="font-mono text-[12px] font-medium text-slate-900 underline underline-offset-2"
                  >
                    {stage.appsNo}
                  </Link>
                  <span className="text-[12px] text-slate-600">
                    step {stage.sequence + 1} of {stage.totalStages} · {stage.stageKey}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">{stage.smId}</span>
                  <span className="ml-auto text-[11px] text-slate-500">
                    raised {formatDateTime(stage.submittedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      <Card className="mb-4">
        {/* A GET form: the filter state lives in the URL, so a filtered view can
            be linked, bookmarked and paged without any client-side state. */}
        <form method="get" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <Field label="Apps_No" htmlFor="q">
            <Input
              id="q"
              name="q"
              defaultValue={filters.q ?? ''}
              placeholder="Contains…"
              className="font-mono"
            />
          </Field>

          <Field label="Status" htmlFor="status">
            <Select id="status" name="status" defaultValue={filters.status ?? ''}>
              <option value="">Any</option>
              {CORRECTION_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Category" htmlFor="category">
            <Select id="category" name="category" defaultValue={filters.category ?? ''}>
              <option value="">Any</option>
              {CORRECTION_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category] ?? category}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="SM_ID" htmlFor="smId">
            <Input id="smId" name="smId" defaultValue={filters.smId ?? ''} className="font-mono" />
          </Field>

          <Field label="Submitted from" htmlFor="from">
            <Input id="from" name="from" type="date" defaultValue={filters.from ?? ''} />
          </Field>

          <Field label="Submitted to" htmlFor="to">
            <Input id="to" name="to" type="date" defaultValue={filters.to ?? ''} />
          </Field>

          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-6">
            <Button type="submit">Apply filters</Button>
            <LinkButton href="/admin/corrections" variant="ghost">
              Clear
            </LinkButton>
          </div>
        </form>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="No correction requests match"
          description={
            total === 0
              ? 'Nothing has been raised yet, or every filter above excludes it.'
              : 'Try a wider date range or clear the filters.'
          }
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Submitted</Th>
                <Th>Apps_No</Th>
                <Th>Category</Th>
                <Th>Field</Th>
                <Th>Proposed</Th>
                <Th>SM_ID</Th>
                <Th>Submitted by</Th>
                <Th>Status</Th>
                <Th>Reviewed</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <Td className="text-[11px] whitespace-nowrap text-slate-500">
                    {formatDateTime(row.submittedAt)}
                    {row.resubmissionCount > 0 ? (
                      <span className="block text-[11px] text-amber-700">
                        resubmitted &times;{row.resubmissionCount}
                      </span>
                    ) : null}
                  </Td>
                  <Td>
                    <Link
                      href={`/admin/records/${encodeURIComponent(row.appsNo)}`}
                      className="font-mono font-medium text-slate-900 underline underline-offset-2 hover:text-slate-600"
                    >
                      {row.appsNo}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap">{CATEGORY_LABELS[row.category] ?? row.category}</Td>
                  <Td className="text-[12px] text-slate-600">{row.fieldLabel}</Td>
                  {/* old → new rather than a strikethrough. The two values are
                      compared character by character down this column, so both
                      are monospaced and the arrow — not a line through one of
                      them — is what says which direction the change runs. */}
                  <Td className="font-mono text-[12px]">
                    <span className="text-slate-500">{orDash(row.originalValue)}</span>
                    <span className="px-1 text-slate-400" aria-hidden="true">
                      →
                    </span>
                    <span className="font-medium text-slate-900">{row.proposedValue}</span>
                  </Td>
                  <Td className="font-mono whitespace-nowrap">{row.smId}</Td>
                  <Td className="text-[12px] text-slate-600">
                    {orDash(row.submitterName ?? row.submitterEmail)}
                  </Td>
                  <Td>
                    {/* The request itself, not just the record it concerns. This
                        column was the only route to a request from an admin
                        screen and it went to the RECORD, so the request an
                        administrator had been notified about was reachable from
                        nowhere. */}
                    <Link
                      href={`/admin/corrections/${row.id}`}
                      className="underline underline-offset-2"
                    >
                      <StatusBadge status={row.status} />
                    </Link>
                  </Td>
                  <Td className="text-[11px] whitespace-nowrap text-slate-500">
                    {row.reviewedAt ? (
                      <>
                        {formatDateTime(row.reviewedAt)}
                        <span className="block text-slate-500">{orDash(row.reviewerName)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>

          <Pagination
            page={page}
            pageCount={pageCount(total, pageSize)}
            totalRows={total}
            hrefFor={(target) => `/admin/corrections${buildQuery(params, { page: target })}`}
          />
        </>
      )}
    </section>
  );
}
