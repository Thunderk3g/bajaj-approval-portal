import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { AUDIT_ACTIONS } from '@/lib/audit/actions';
import { formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams, PAGE_SIZES } from '@/lib/pagination';
import {
  Alert,
  Badge,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Pagination,
  PageHeader,
  Select,
  Table,
  Td,
  Th,
  type BadgeTone,
} from '@/components/ui';
import { distinctEntityTypes, listAuditLog } from './queries';
import { AuditPayload } from './payload';

export const metadata: Metadata = {
  title: 'Audit log · Sales Data Review Portal',
};

// The trail must never be served from a cache: an admin checking what just
// happened is the one reader who cannot tolerate a stale page.
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const ROLE_TONE: Record<string, BadgeTone> = {
  admin: 'danger',
  approver: 'info',
  sales: 'neutral',
};

function one(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The /admin layout is the authorization boundary, but this page re-checks
  // anyway. Section 4.1: a route that trusts its parent to have checked is one
  // refactor away from being reachable without one.
  try {
    await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const params = await searchParams;
  const { page, pageSize, offset } = parsePageParams(params);

  const filters = {
    action: one(params.action),
    actor: one(params.actor),
    entityType: one(params.entityType),
    entityId: one(params.entityId),
    from: one(params.from),
    to: one(params.to),
  };

  const [{ rows, total }, entityTypes] = await Promise.all([
    listAuditLog(filters, { limit: pageSize, offset }),
    distinctEntityTypes(),
  ]);

  const hasFilters = Object.values(filters).some((v) => v !== '');

  return (
    <section>
      <PageHeader
        title="Audit log"
        description="Every recorded action, newest first. Actor email and role are the values captured when the action happened, not the user's current details."
      />

      <Alert tone="info" title="Append-only">
        Entries cannot be edited or removed. The database rejects any UPDATE or DELETE against this
        table, so what is shown here is what was written.
      </Alert>

      <form method="get" className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Action" htmlFor="action">
            <Select id="action" name="action" defaultValue={filters.action}>
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Actor email" htmlFor="actor" hint="Matches the email recorded on the row.">
            <Input id="actor" name="actor" defaultValue={filters.actor} placeholder="name@bajajlife.com" />
          </Field>

          <Field label="Entity type" htmlFor="entityType">
            <Select id="entityType" name="entityType" defaultValue={filters.entityType}>
              <option value="">Any entity</option>
              {entityTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Entity ID" htmlFor="entityId">
            <Input id="entityId" name="entityId" defaultValue={filters.entityId} />
          </Field>

          <Field label="From" htmlFor="from" hint="Interpreted as UTC.">
            <Input id="from" name="from" type="date" defaultValue={filters.from} />
          </Field>

          <Field label="To" htmlFor="to" hint="Inclusive of the whole day.">
            <Input id="to" name="to" type="date" defaultValue={filters.to} />
          </Field>

          <Field label="Rows per page" htmlFor="pageSize">
            <Select id="pageSize" name="pageSize" defaultValue={String(pageSize)}>
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
          >
            Apply filters
          </button>
          {hasFilters ? (
            <LinkButton href="/admin/audit" variant="secondary">
              Clear
            </LinkButton>
          ) : null}
        </div>
      </form>

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState
            title={hasFilters ? 'No entries match those filters' : 'No audit entries yet'}
            description={
              hasFilters
                ? 'Widen the date range or clear the action filter.'
                : 'Entries appear as soon as anyone signs in, uploads a file, or decides a request.'
            }
          />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Actor</Th>
                  <Th>Action</Th>
                  <Th>Entity</Th>
                  <Th>Change</Th>
                  <Th>IP</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <Td className="whitespace-nowrap text-slate-600">
                      {formatDateTime(row.createdAt)}
                    </Td>
                    <Td>
                      <span className="block break-all">{orDash(row.actorEmail)}</span>
                      {row.actorRole ? (
                        <span className="mt-0.5 inline-block">
                          <Badge tone={ROLE_TONE[row.actorRole] ?? 'neutral'}>{row.actorRole}</Badge>
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">system</span>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-xs">{row.action}</Td>
                    <Td>
                      <span className="block text-xs text-slate-500">{row.entityType}</span>
                      <span className="block break-all font-mono text-xs">
                        {orDash(row.entityId)}
                      </span>
                    </Td>
                    <Td className="min-w-64">
                      <AuditPayload before={row.before} after={row.after} />
                    </Td>
                    <Td className="whitespace-nowrap font-mono text-xs text-slate-500">
                      {orDash(row.ipAddress)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <Pagination
              page={page}
              pageCount={pageCount(total, pageSize)}
              totalRows={total}
              hrefFor={(next) => `/admin/audit${buildQuery(params, { page: next })}`}
            />
          </>
        )}
      </div>
    </section>
  );
}
