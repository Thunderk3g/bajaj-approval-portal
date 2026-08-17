import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';
import { formatDateTime, orDash } from '@/lib/format';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import { listRoster, listUserIds, listUsers, userCounts } from '@/lib/users/queries';
import { rosterKey } from '@/lib/roster/entries';
import { resolveHierarchy } from '@/lib/hierarchy/queries';
import { ROLES } from '@/lib/users/schema';
import {
  Badge,
  Button,
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
import { PeopleTabs } from '@/components/admin/people-tabs';
import { BulkRemove, BulkSelectCheckbox } from './bulk-remove';
import { RosterBulkProvision } from './roster-bulk';
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

  const active = activeFilter === 'active' || activeFilter === 'inactive' ? activeFilter : null;

  const [{ rows, total }, matchingIds, roster, counts] = await Promise.all([
    listUsers({ q, role: roleFilter, active, limit: pageSize, offset }),
    // The whole filtered set, so "select all matching" can mean what it says
    // rather than "all 25 of them that fitted on this page".
    listUserIds({ q, role: roleFilter, active }),
    listRoster(),
    userCounts(),
  ]);

  // "Assign now" carries both, because one person can hold two rungs and the
  // code alone would not say which account the admin clicked.
  const prefillCode = one(params.code).toUpperCase();
  const prefillRung = one(params.rung);
  const prefilled = prefillCode
    ? roster.find((r) => r.code === prefillCode && r.rung === prefillRung)
    : undefined;
  const unprovisioned = roster.filter((r) => r.accountEmail === null);

  // Where the roster already places this rep. Read here rather than typed on the
  // form: an SM belongs to a TL and that TL to an ACM, and the person creating
  // the account should be shown that chain rather than asked to reproduce it —
  // a hand-typed placement that disagrees with the roster is a login whose
  // approval steps route somewhere the data does not agree with.
  const node = prefilled?.rung === 'sales' ? await resolveHierarchy(prefillCode) : null;
  const placement = node ? { tlId: node.tlId, acmId: node.acmId } : null;

  return (
    <section>
      <PeopleTabs current="/admin/users" />

      <PageHeader
        title="Users"
        description="Accounts are created here or by the first-admin setup script. There is no public sign-up, and accounts are deactivated rather than deleted."
        actions={
          // A jump link, not a second form: creation lives in one place on this
          // page and the header only has to get you there.
          <LinkButton href="#create-account" variant="primary">
            Create user
          </LinkButton>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Accounts" value={counts.total} />
        <StatCard label="Active" value={counts.active} tone="success" />
        <StatCard label="Sales accounts" value={counts.sales} />
        <StatCard
          label="On the sheet, no account"
          value={counts.unprovisioned}
          tone={counts.unprovisioned > 0 ? 'warning' : 'default'}
          hint="Reps, team leaders and area managers from the Manpower sheet."
        />
      </div>

      <div className="mt-4">
        <Card>
          <form method="get">
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
            <div className="mt-3 flex items-center gap-2">
              <Button type="submit">Filter</Button>
              {q || roleFilter || activeFilter ? (
                <LinkButton href="/admin/users" variant="ghost">
                  Clear
                </LinkButton>
              ) : null}
            </div>
          </form>
        </Card>
      </div>

      <div className="mt-4">
        {rows.length === 0 ? (
          <EmptyState title="No accounts match those filters" />
        ) : (
          <>
            <BulkRemove
              selectableIds={rows.filter((r) => r.id !== admin.id).map((r) => r.id)}
              // Never the admin's own account, on either control. Removing it
              // signs them out mid-batch and, if they were the last admin,
              // leaves nobody able to undo any of it.
              allMatchingIds={matchingIds.filter((id) => id !== admin.id)}
              filtered={Boolean(q || roleFilter || activeFilter)}
            >
              <Table>
                <thead>
                  <tr>
                    <Th>
                      <span className="sr-only">Select</span>
                    </Th>
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th>Role</Th>
                    <Th>Scope</Th>
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
                      <Td>
                        {row.id === admin.id ? (
                          // Never selectable. Removing your own account signs you
                          // out mid-batch and, if you were the last admin, leaves
                          // nobody able to undo any of it.
                          <span className="sr-only">Your own account</span>
                        ) : (
                          <BulkSelectCheckbox id={row.id} label={row.email} />
                        )}
                      </Td>
                      <Td className="font-medium">{row.name}</Td>
                      <Td className="break-all text-[12px] text-slate-600">{row.email}</Td>
                      <Td>
                        <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{row.role}</Badge>
                      </Td>
                      <Td className="font-mono whitespace-nowrap">
                        {orDash(row.smId ?? row.tlCode ?? row.acmCode)}
                      </Td>
                      <Td>
                        {row.isActive ? (
                          <Badge tone="success">active</Badge>
                        ) : (
                          <Badge tone="neutral">deactivated</Badge>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-[12px] text-slate-600">
                        {formatDateTime(row.createdAt)}
                      </Td>
                      <Td>
                        <UserRowActions
                          userId={row.id}
                          email={row.email}
                          isActive={row.isActive}
                          isSelf={row.id === admin.id}
                        />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </BulkRemove>

            <Pagination
              page={page}
              pageCount={pageCount(total, pageSize)}
              totalRows={total}
              hrefFor={(next) => `/admin/users${buildQuery(params, { page: next })}`}
            />
          </>
        )}
      </div>

      {/*
        Creation sits below the list, not above it.

        This page is read far more often than it is written to — an admin comes
        here to find out who has access, and provisions an account occasionally.
        Leading with a nine-field form pushed the account it answers questions
        about below the fold.

        The id is load-bearing: the worklist links in with ?smId=…#create-account
        so the prefilled form is what the browser lands on, which is the whole
        point of that link.
      */}
      <div className="mt-6" id="create-account">
        <Card
          title="Create an account"
          description="Assign the role, and for Sales the SM_ID that scopes them to their records."
        >
          {/*
            Keyed on the prefill, and it is load-bearing rather than a hint.

            "Assign now" navigates to ?smId=… on the page already showing, which
            React treats as a re-render, not a remount. The form's inputs are
            uncontrolled — `defaultValue` is read once at mount and ignored after
            — and its `role` lives in `useState(defaults.role)`, which is an
            initial value, not a subscription. So the link changed the URL, the
            server sent new defaults, and the form kept the empty state it had
            been mounted with: the button appeared to do nothing at all.

            A changing key forces a fresh mount, which is what makes both the
            prefilled SM_ID and the switch to the Sales role take effect.
          */}
          <CreateUserForm
            key={prefilled ? `${prefilled.rung}:${prefilled.code}` : 'blank'}
            defaults={{
              name: prefilled?.name ?? undefined,
              role: prefilled?.rung,
              // One field per rung, the one that role actually reads. The sheet
              // decides which; the link only says who was clicked.
              smId: prefilled?.rung === 'sales' ? prefilled.code : undefined,
              tlCode: prefilled?.rung === 'tl' ? prefilled.code : undefined,
              acmCode: prefilled?.rung === 'acm' ? prefilled.code : undefined,
              placement,
            }}
          />
        </Card>
      </div>

      <div className="mt-4">
        <Card
          title="Provisioning worklist"
          description="Everybody the Manpower sheet names — area managers, team leaders and reps — who has no account yet. Nothing here comes from imported policy or lead data: the sheet says who the people are, and it is the only thing that does."
        >
          {/*
            The table, its empty state and the bulk controls all live inside the
            one client component. Passwords come back from that action and exist
            nowhere else, so the subtree holding them must not be the subtree the
            server swaps out when the last worklist row is provisioned away.
          */}
          {/*
            The whole worklist, not a page of it. It is one row per person the
            sheet names without an account — a few hundred at most, and the
            searching and the "create every match" button both have to see rows
            the server did not slice off. Filtering here rather than through the
            URL is what keeps it: a GET form would remount this subtree, and the
            generated passwords it holds exist nowhere else.
          */}
          <RosterBulkProvision
            entries={unprovisioned.map((entry) => ({
              key: rosterKey(entry),
              code: entry.code,
              name: entry.name,
              rung: entry.rung,
              alsoRungs: entry.alsoRungs,
              location: entry.location,
              parentCode: entry.parentCode,
              reports: entry.reports,
            }))}
          />
        </Card>
      </div>
    </section>
  );
}
