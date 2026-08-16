import { notFound } from 'next/navigation';
import { Card, LinkButton, PageHeader, Pagination, StatCard } from '@/components/ui';
import { RecordFilterBar } from '@/components/records/record-filters';
import { RecordTable } from '@/components/records/record-table';
import { RecordDetail } from '@/components/records/record-detail';
import { VersionHistory } from '@/components/records/version-history';
import type { SessionUser } from '@/lib/auth/rbac';
import { listTeam } from '@/lib/managers/queries';
import { buildQuery, pageCount, parsePageParams } from '@/lib/pagination';
import {
  EMPTY_FILTERS,
  filterFormValues,
  parseRecordFilters,
  type SearchParams,
} from '@/lib/records/filters';
import {
  countRecords,
  getRecord,
  listBatchOptions,
  listRecords,
  listStatusOptions,
  listTlOptions,
} from '@/lib/records/query';
import { listRecordVersions } from '@/lib/records/versions';

/**
 * The record browser a team leader and an area manager share — 2026-08-06 spec §5.
 *
 * Written once and rendered under both `/tl/records` and `/acm/records`, the same
 * way `manager-screens.tsx` shares the queue and the team list: the two roles ask
 * the same question of a different set of SM_IDs, and two copies would be two
 * places to fix the day the grid gains a column.
 *
 * It exists because managers previously had no way to LOOK at their team's book
 * at all. The only screen that took an application number was "raise a request",
 * so a TL who wanted to check a policy had to start a correction they did not
 * intend to file. Everything here is the sales grid with a rep column added; no
 * new query was needed, because `scopedRecordCondition` already resolves a
 * manager's whole team and `recordWhere` seeds every record query with it.
 */

type Role = 'tl' | 'acm';

const WORDS: Record<
  Role,
  { title: string; description: string; scope: string; empty: string }
> = {
  tl: {
    title: "My team's records",
    description:
      'Every application credited to a rep the roster places under you, including any admin reassignments. Filter by rep to work one book at a time.',
    scope: 'your team',
    empty: 'No rep is placed under your TL code yet',
  },
  acm: {
    title: "My cluster's records",
    description:
      'Every application credited to a rep beneath you, across all of your team leaders. The Team leader column says which team each rep sits in.',
    scope: 'your cluster',
    empty: 'No rep is placed under your ACM code yet',
  },
};

/* -------------------------------------------------------------------- list */

export async function ManagerRecords({
  user,
  role,
  params,
}: {
  user: SessionUser;
  role: Role;
  params: SearchParams;
}) {
  const words = WORDS[role];
  const basePath = `/${role}/records`;

  const filters = parseRecordFilters(params, user);
  const page = parsePageParams(params);

  // `listTeam` is the roster read the /tl/team screen already uses, reused here
  // for the rep dropdown and — for an ACM — the SM_ID → TL map. Reading the
  // roster rather than `distinct sales_record.sm_id` means a rep with no rows
  // this month is still offered, and the two screens cannot disagree about who
  // reports to this manager.
  const [{ rows, total }, gapTotal, statusOptions, batchOptions, team, tlOptions] =
    await Promise.all([
      listRecords(user, filters, page),
      countRecords(user, { ...EMPTY_FILTERS, gap: 'ANY' }),
      listStatusOptions(user),
      listBatchOptions(user),
      listTeam(user),
      // Empty for a TL without a query — `TL_ID_FILTER_ROLES` excludes them, so
      // the picker below never renders and the parser would drop `?tlId=` anyway.
      listTlOptions(user),
    ]);

  const tlBySmId =
    role === 'acm' ? new Map(team.map((member) => [member.smId, member.tlId])) : undefined;

  // Said out loud, because a filter arriving from a link on the performance
  // report is one the manager never touched a control to set — a grid quietly
  // showing 93 of 315 rows with no explanation reads as missing data.
  const drilledTl = filters.tlId
    ? (tlOptions.find((option) => option.tlId === filters.tlId) ?? { tlId: filters.tlId, tlName: null })
    : null;

  return (
    <section className="space-y-4">
      <PageHeader
        title={
          drilledTl ? `${drilledTl.tlName ?? drilledTl.tlId}'s team records` : words.title
        }
        description={
          drilledTl
            ? `Narrowed to the team led by ${drilledTl.tlId}${
                drilledTl.tlName ? ` (${drilledTl.tlName})` : ''
              }, including that team leader's own book. Clear the Team leader filter to see all of ${words.scope} again.`
            : words.description
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label={`Records in ${words.scope}`} value={total.toLocaleString('en-IN')} />
        <StatCard
          label="Rows with a gap"
          value={gapTotal.toLocaleString('en-IN')}
          tone={gapTotal > 0 ? 'warning' : 'success'}
          hint="ISSUED applications missing AutoPay, an issuance date, or a policy number"
          href={`${basePath}?gap=ANY`}
        />
        <StatCard
          label="Reps beneath you"
          value={team.length.toLocaleString('en-IN')}
          hint={team.length === 0 ? words.empty : undefined}
          href={`/${role}/team`}
        />
      </div>

      <RecordFilterBar
        basePath={basePath}
        values={filterFormValues(filters)}
        pageSize={page.pageSize}
        // The rep picker is the point of this screen: a manager's scope holds
        // many books and "show me just this one" is the first thing they ask.
        // Safe because `recordWhere` ANDs it with the team predicate, so a
        // hand-typed SM_ID from another team narrows to nothing.
        showSmId
        smIdOptions={team.map((member) => ({ smId: member.smId, smName: member.smName }))}
        // One rung up, and only for the role whose scope spans several teams —
        // a TL leading exactly one team would be offered a filter that either
        // changes nothing or empties the grid.
        showTlId={role === 'acm'}
        tlIdOptions={tlOptions}
        statusOptions={statusOptions}
        batchOptions={batchOptions}
      />

      <RecordTable
        rows={rows}
        basePath={basePath}
        detailBase={basePath}
        query={params}
        sort={filters.sort}
        dir={filters.dir}
        variant="manager"
        tlBySmId={tlBySmId}
      />

      <Pagination
        page={page.page}
        pageCount={pageCount(total, page.pageSize)}
        totalRows={total}
        hrefFor={(next) => `${basePath}${buildQuery(params, { page: next })}`}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ detail */

export async function ManagerRecordDetail({
  user,
  role,
  appsNo,
}: {
  user: SessionUser;
  role: Role;
  appsNo: string;
}) {
  // `getRecord` composes `scopedRecordCondition`, so an application belonging to
  // another team comes back null and renders as a 404 — deliberately
  // indistinguishable from an Apps_No that does not exist. A 403 would confirm
  // the application is real and belongs to somebody, which is the leak itself
  // (spec section 4.1). Asserted in tests/integration/manager-records.test.ts.
  const record = await getRecord(user, appsNo);
  if (!record) notFound();

  const versions = await listRecordVersions(user, appsNo);

  return (
    <section className="space-y-4">
      <PageHeader
        title={`Application ${record.appsNo}`}
        description={record.clientName ?? undefined}
        actions={
          <>
            {/*
              The reason this screen exists. A manager who spots something wrong
              is one click from filing it, against the record they are looking
              at, instead of retyping a 10-digit identifier into a blank form —
              which is what they were doing before /tl/records existed.
            */}
            <LinkButton
              href={`/${role}/requests/new?appsNo=${encodeURIComponent(record.appsNo)}`}
              variant="primary"
            >
              Raise a request for this policy
            </LinkButton>
            <LinkButton href={`/${role}/records`}>Back to records</LinkButton>
          </>
        }
      />

      <RecordDetail record={record} />

      <Card
        title="Version history"
        description="Every change to this record, newest first, each diffed against the version before it."
      >
        <VersionHistory versions={versions} />
      </Card>
    </section>
  );
}
