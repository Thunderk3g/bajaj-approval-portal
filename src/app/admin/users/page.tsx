import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import { listRoster, listUsers, userCounts } from '@/lib/users/queries';
import { ROLES } from '@/lib/users/schema';
import {
  Badge,
  Card,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Pagination,
  PageHeader,
  Select,
  StatCard,
  Table,
  Td,
  Th,
  type BadgeTone,
} from '@/components/ui';
import { CreateUserForm } from './create-user-form';
import { UserRowActions } from './user-row-actions';

export const metadata: Metadata = {
  title: 'Users · Sales Data Review Portal',
};

// Account state decides who can sign in; a cached page here would show an admin
// a roster that no longer reflects who has access.
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

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  // The /admin layout is the authorization boundary, but this page re-checks
  // anyway. Section 4.1: a route that trusts its parent to have checked is one
  // refactor away from being reachable without one.
  let admin;
  try {
    admin = await requireRole('admin');
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }

  const params = await searchParams;
  const { page, pageSize, offset } = parsePageParams(params);

  const q = one(params.q);
  const roleFilter = one(params.role);
  const activeFilter = one(params.active);

  const [{ rows, total }, roster, counts] = await Promise.all([
    listUsers({
      q,
      role: roleFilter,
      active: activeFilter === 'active' || activeFilter === 'inactive' ? activeFilter : null,
      limit: pageSize,
      offset,
    }),
    listRoster(),
    userCounts(),
  ]);

  const prefillSmId = one(params.smId).toUpperCase();
  const prefilled = prefillSmId ? roster.find((r) => r.smId === prefillSmId) : undefined;
  const unprovisioned = roster.filter((r) => r.accountEmail === null);

  return (
    <section>
      <PageHeader
        title="Users"
        description="Accounts are created here or by the first-admin setup script. There is no public sign-up, and accounts are deactivated rather than deleted."
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Accounts" value={counts.total} />
        <StatCard label="Active" value={counts.active} tone="success" />
        <StatCard label="Sales accounts" value={counts.sales} />
        <StatCard
          label="SM_IDs without an account"
          value={counts.unprovisioned}
          tone={counts.unprovisioned > 0 ? 'warning' : 'default'}
          hint="From the roster and from imported records."
        />
      </div>

      <div className="mt-6">
        <Card
          title="Create an account"
          description="Assign the role, and for Sales the SM_ID that scopes them to their records."
        >
          <CreateUserForm
            defaults={{
              smId: prefilled?.smId ?? (prefillSmId || undefined),
              name: prefilled?.smName ?? undefined,
              role: prefillSmId ? 'sales' : undefined,
              orphan: prefilled?.isOrphan ?? false,
            }}
          />
        </Card>
      </div>

      <div className="mt-6">
        <Card
          title="Provisioning worklist"
          description="SM_IDs seen in the roster or in imported records that have no account yet."
        >
          {unprovisioned.length === 0 ? (
            <EmptyState
              title="Every known SM_ID has an account"
              description="New IDs appear here after the next import."
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>SM_ID</Th>
                  <Th>Name</Th>
                  <Th>Location</Th>
                  <Th>Roster</Th>
                  <Th>
                    <span className="sr-only">Action</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {unprovisioned.slice(0, 25).map((entry) => (
                  <tr key={entry.smId}>
                    <Td className="font-mono whitespace-nowrap">{entry.smId}</Td>
                    <Td>{orDash(entry.smName)}</Td>
                    <Td className="text-slate-600">{orDash(entry.location)}</Td>
                    <Td>
                      {entry.isOrphan ? (
                        <Badge tone="warning">not on roster</Badge>
                      ) : (
                        <Badge tone="neutral">on roster</Badge>
                      )}
                    </Td>
                    <Td>
                      <LinkButton
                        href={`/admin/users?smId=${encodeURIComponent(entry.smId)}`}
                        variant="secondary"
                        className="px-2.5 py-1.5 text-xs"
                      >
                        Create account
                      </LinkButton>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {unprovisioned.length > 25 ? (
            <p className="mt-3 text-xs text-slate-500">
              Showing the first 25 of {unprovisioned.length}.
            </p>
          ) : null}
        </Card>
      </div>

      <div className="mt-6">
        <form method="get" className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Search" htmlFor="q" hint="Name, email or SM_ID.">
              <Input id="q" name="q" defaultValue={q} />
            </Field>
            <Field label="Role" htmlFor="role">
              <Select id="role" name="role" defaultValue={roleFilter}>
                <option value="">Any role</option>
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="State" htmlFor="active">
              <Select id="active" name="active" defaultValue={activeFilter}>
                <option value="">Any state</option>
                <option value="active">Active</option>
                <option value="inactive">Deactivated</option>
              </Select>
            </Field>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-1.5 rounded bg-slate-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2"
            >
              Filter
            </button>
            {q || roleFilter || activeFilter ? (
              <Link
                href="/admin/users"
                className="rounded px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Clear
              </Link>
            ) : null}
          </div>
        </form>
      </div>

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState title="No accounts match those filters" />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>SM_ID</Th>
                  <Th>State</Th>
                  <Th>Created</Th>
                  <Th>
                    <span className="sr-only">Actions</span>
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <Td className="font-medium">{row.name}</Td>
                    <Td className="break-all text-slate-600">{row.email}</Td>
                    <Td>
                      <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{row.role}</Badge>
                    </Td>
                    <Td className="font-mono whitespace-nowrap">{orDash(row.smId)}</Td>
                    <Td>
                      {row.isActive ? (
                        <Badge tone="success">active</Badge>
                      ) : (
                        <Badge tone="neutral">deactivated</Badge>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-slate-600">
                      {formatDateTime(row.createdAt)}
                    </Td>
                    <Td>
                      <UserRowActions
                        userId={row.id}
                        isActive={row.isActive}
                        isSelf={row.id === admin.id}
                      />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <Pagination
              page={page}
              pageCount={pageCount(total, pageSize)}
              totalRows={total}
              hrefFor={(next) => `/admin/users${buildQuery(params, { page: next })}`}
            />
          </>
        )}
      </div>
    </section>
  );
}
