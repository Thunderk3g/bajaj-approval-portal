/**
 * Issuance, refusal and login share — one scoped module behind four screens.
 *
 * The business asked for "TL performance, SM performance and ACM performance".
 * Those are one report grouped three ways, not three reports: the numerator, the
 * denominator and the scoping rule are identical at every rung and only the
 * GROUP BY moves. Building it once is also the only way the four pages can
 * disagree about nothing, which matters because the product owner's feedback
 * round will change these definitions and a change has to land in one place.
 *
 * The definitions, stated once so a reader never has to infer them:
 *
 *   Logins    every row. A row existing IS an application logged.
 *   Issued    status = ISSUED, the same predicate the gap counts use.
 *   Refused   status = REJECTED.
 *   Pending   the remainder — logins − issued − refused, so the three ALWAYS
 *             sum back to logins. `status` is free text, so a fourth value is a
 *             thing that can happen; it lands in Pending rather than vanishing,
 *             and `unclassified` counts it so the screen can say so out loud.
 *   Issuance% issued / logins
 *   Refusal%  refused / logins
 *   Share%    this row's logins / the SCOPED total logins. "Login percentage"
 *             for one person has no other defensible reading — a person has no
 *             denominator of their own — and the scoped total is what makes a
 *             TL's page add to 100% across their own reps.
 *   ANP / FP  numeric(18,2) summed IN POSTGRES and carried out as a string.
 *             Never parsed to a float: `sum` on numeric is exact, and the
 *             export path went to the trouble of paise-and-BigInt for the same
 *             reason (src/lib/export/build.ts).
 *
 * Every ratio can divide by zero — a rep with no logins at all is a real and
 * common row — so they return `null` and render as an em dash. Zero logins and
 * zero issuance are different facts and a screen that showed both as "0%" would
 * be telling a manager somebody sold nothing when in fact nobody knows.
 */

import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { db } from '@/db/client';
import { manpower, manpowerOverride, salesRecord } from '@/db/schema';
import { AuthzError } from '@/lib/auth/errors';
import {
  GLOBAL_READ_ROLES,
  scopedRecordCondition,
  teamSmIds,
  type SessionUser,
} from '@/lib/auth/rbac';
import { resolveHierarchy } from '@/lib/hierarchy/queries';
import { PLACEHOLDER_CODE_LIST } from '@/lib/roster/placeholders';
import { ISSUED_CONDITION, countAll, countFiltered } from './sql';

/** The refusal side of the same free-text column `ISSUED_STATUS` reads. */
export const REFUSED_STATUS = 'REJECTED';
/** The one status that is neither an outcome nor an anomaly — still in flight. */
export const PENDING_STATUS = 'PENDING';

export type PerformanceRung = 'sm' | 'tl' | 'acm';

export const RUNG_LABELS: Record<PerformanceRung, string> = {
  sm: 'Sales manager',
  tl: 'Team leader',
  // The label follows the people; the column behind it is `ccm_id` (ui-flows §2).
  acm: 'Area manager',
};

export type PerformanceMetrics = {
  logins: number;
  issued: number;
  refused: number;
  /** logins − issued − refused. Includes `unclassified`. */
  pending: number;
  /**
   * Rows whose status is none of ISSUED / REJECTED / PENDING.
   *
   * Zero here is the normal case and the number is only ever surfaced when it is
   * not zero — but it must be surfaced, because otherwise a status the import
   * has never seen before is silently reported as pending business.
   */
  unclassified: number;
  /** numeric(18,2) exactly as Postgres summed it. Format, never parse. */
  anp: string;
  fp: string;
};

export type PerformanceRow = PerformanceMetrics & {
  /**
   * The grouping key. Null at the TL/ACM rungs means the roster places these
   * policies under nobody — a data gap, and the row is kept rather than dropped.
   */
  code: string | null;
  name: string | null;
  /** `DIY` / `111222-UN` — a bucket in the source data, not a person. */
  placeholder: boolean;
};

export type PerformanceReport = {
  rung: PerformanceRung;
  /** People, biggest book first. Placeholder codes are never in here. */
  rows: PerformanceRow[];
  /** The placeholder buckets, counted separately so the totals reconcile. */
  placeholders: PerformanceRow[];
  /** Everything in scope, placeholders included. `rows + placeholders`. */
  totals: PerformanceMetrics;
};

/* ------------------------------------------------------------- pure ratios */

/**
 * A ratio, or null when there is no denominator to divide by.
 *
 * Separate from its formatting on purpose: a caller sorting a column needs the
 * number, and a caller rendering a cell needs the em dash, and collapsing the
 * two would mean sorting on the string "—".
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/** One decimal: 63.2% and 63.4% are different reps, 63.24% is noise. */
export function formatPercent(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

export function issuanceRate(row: PerformanceMetrics): number | null {
  return ratio(row.issued, row.logins);
}

export function refusalRate(row: PerformanceMetrics): number | null {
  return ratio(row.refused, row.logins);
}

/** This row's share of the SCOPED total — the only sane per-person "login %". */
export function loginShare(row: PerformanceMetrics, totals: PerformanceMetrics): number | null {
  return ratio(row.logins, totals.logins);
}

export const ZERO_METRICS: PerformanceMetrics = {
  logins: 0,
  issued: 0,
  refused: 0,
  pending: 0,
  unclassified: 0,
  // Two decimals like every other money string in the app, so an empty scope
  // and a scope that summed to nothing render identically.
  anp: '0.00',
  fp: '0.00',
};

/**
 * Adds a set of rows up the way the database would.
 *
 * Money is summed as integer paise through BigInt rather than as floats: two
 * `numeric(18,2)` strings added with `+` in JavaScript drift at the fourth rep,
 * and the whole point of these being strings all the way from Postgres is that
 * they never become doubles.
 */
export function sumMetrics(rows: readonly PerformanceMetrics[]): PerformanceMetrics {
  const total = { ...ZERO_METRICS };
  let anp = 0n;
  let fp = 0n;

  for (const row of rows) {
    total.logins += row.logins;
    total.issued += row.issued;
    total.refused += row.refused;
    total.pending += row.pending;
    total.unclassified += row.unclassified;
    anp += toPaise(row.anp);
    fp += toPaise(row.fp);
  }

  return { ...total, anp: fromPaise(anp), fp: fromPaise(fp) };
}

/** `"1234.50"` → `123450n`. Anything unreadable counts as nothing, not as NaN. */
function toPaise(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return 0n;
  const [, sign, whole, fraction = ''] = match;
  const paise = BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return sign === '-' ? -paise : paise;
}

function fromPaise(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/* --------------------------------------------------- URL params and sorting */

export const PERFORMANCE_SORTS = [
  'name',
  'logins',
  'issued',
  'refused',
  'pending',
  'issuance',
  'refusal',
  'share',
  'anp',
  'fp',
] as const;
export type PerformanceSort = (typeof PERFORMANCE_SORTS)[number];

export type PerformanceParams = {
  rung: PerformanceRung;
  sort: PerformanceSort;
  dir: 'asc' | 'desc';
  /** A period code, or `'all'`. Resolved to an id by the page. */
  period: string;
};

/**
 * Query string to a typed view state, never rejecting.
 *
 * Same rule as the record grid's filters: this is a URL people bookmark and
 * hand-edit, so `?sort=nonsense` degrades to the default rather than to a stack
 * trace. `allowed` is what stops a rep from reaching the ACM grouping by typing
 * `?rung=acm` — the data would still be scoped to them, but the page would then
 * offer a rung its own copy does not describe.
 */
export function parsePerformanceParams(
  params: Record<string, string | string[] | undefined>,
  allowed: readonly PerformanceRung[],
): PerformanceParams {
  const one = (key: string): string | undefined => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const rung = one('rung');
  const sort = one('sort');
  const dir = one('dir');

  return {
    rung: allowed.includes(rung as PerformanceRung) ? (rung as PerformanceRung) : allowed[0],
    sort: PERFORMANCE_SORTS.includes(sort as PerformanceSort)
      ? (sort as PerformanceSort)
      : 'logins',
    dir: dir === 'asc' ? 'asc' : 'desc',
    period: one('period') ?? '',
  };
}

export type PeriodFilter = {
  /** null means every period — the report is not narrowed at all. */
  periodId: string | null;
  /** What belongs back in the URL and the select. */
  code: string;
  options: Array<{ id: string; code: string; label: string; status: string }>;
};

/**
 * `?period=` to a period id, defaulting to the month that is open.
 *
 * The open period is the default because it is the month somebody is actually
 * reconciling; "all periods" is the deliberate widening, not the resting state.
 * A code that names no period resolves to every period and is handed BACK
 * unchanged so the screen can say the link was stale — quietly showing the open
 * month instead would answer a question nobody asked.
 */
export async function resolvePeriodFilter(requested: string): Promise<PeriodFilter> {
  // Imported here rather than at the top: `@/lib/periods/queries` pulls in the
  // corrections service for one constant, and a module that needs a list of
  // months should not drag the whole correction engine into the graph of every
  // page that renders a period dropdown.
  const { periodOptions } = await import('@/lib/periods/queries');
  const options = await periodOptions();

  if (requested === 'all') return { periodId: null, code: 'all', options };

  if (requested) {
    const match = options.find((option) => option.code === requested);
    return { periodId: match?.id ?? null, code: requested, options };
  }

  const open = options.find((option) => option.status === 'OPEN');
  return open
    ? { periodId: open.id, code: open.code, options }
    : { periodId: null, code: 'all', options };
}

/** Sorts a copy. Money compares as a number, which is ordering, not arithmetic. */
export function sortPerformanceRows(
  rows: readonly PerformanceRow[],
  totals: PerformanceMetrics,
  sort: PerformanceSort,
  dir: 'asc' | 'desc',
): PerformanceRow[] {
  const of = (row: PerformanceRow): number | null => {
    switch (sort) {
      case 'logins':
        return row.logins;
      case 'issued':
        return row.issued;
      case 'refused':
        return row.refused;
      case 'pending':
        return row.pending;
      case 'issuance':
        return issuanceRate(row);
      case 'refusal':
        return refusalRate(row);
      case 'share':
        return loginShare(row, totals);
      case 'anp':
        return Number(row.anp);
      case 'fp':
        return Number(row.fp);
      default:
        return null;
    }
  };

  const sign = dir === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (sort === 'name') {
      const left = (a.name ?? a.code ?? '￿').toLowerCase();
      const right = (b.name ?? b.code ?? '￿').toLowerCase();
      return left === right ? 0 : (left < right ? -1 : 1) * sign;
    }

    const left = of(a);
    const right = of(b);
    // A row with no ratio at all sorts to the bottom in BOTH directions. It has
    // no position on the scale being sorted, and treating null as zero would
    // rank a rep with no logins above one who issued nothing.
    if (left === null && right === null) return b.logins - a.logins;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * sign;
  });
}

/* ----------------------------------------------------------------- the SQL */

const STATUS = sql`upper(btrim(coalesce(${salesRecord.status}, '')))`;

const REFUSED_CONDITION: SQL = sql`${STATUS} = ${REFUSED_STATUS}`;

/**
 * A status the portal has no name for.
 *
 * The production workbook carries exactly three, but `status` is free text with
 * no CHECK behind it, so this is the tripwire for a fourth arriving in a future
 * import — see `PerformanceMetrics.unclassified`.
 */
const UNCLASSIFIED_CONDITION: SQL = sql`${STATUS} not in (${sql.join(
  [sql`'ISSUED'`, sql`${REFUSED_STATUS}`, sql`${PENDING_STATUS}`],
  sql`, `,
)})`;

/** True for the source's own buckets: `DIY`, `111222-UN`. */
const PLACEHOLDER_CONDITION: SQL = sql`upper(btrim(${salesRecord.smId})) in (${sql.join(
  PLACEHOLDER_CODE_LIST.map((code) => sql`${code}`),
  sql`, `,
)})`;

// The effective hierarchy — the roster with any admin override applied, the
// same `coalesce` precedence resolveHierarchy, scopedRecordCondition and the
// coverage chart all use. A rep an admin moved counts towards the team they are
// actually on, at every rung and on every screen.
const EFFECTIVE_TL = sql`coalesce(${manpowerOverride.tlId}, ${manpower.tlId})`;
const EFFECTIVE_ACM = sql`coalesce(${manpowerOverride.ccmId}, ${manpower.ccmId})`;

/**
 * The grouping key, per rung.
 *
 * At the manager rungs a placeholder is forced to NULL rather than grouped by
 * whatever the sheet wrote: the Manpower sheet carries a `DIY` row naming `DIY`
 * as its own team leader, and grouping on it verbatim invents a team leader
 * called DIY with a book of digital-channel policies.
 */
function keyExpression(rung: PerformanceRung): SQL {
  if (rung === 'sm') return sql`${salesRecord.smId}`;
  const effective = rung === 'tl' ? EFFECTIVE_TL : EFFECTIVE_ACM;
  return sql`(case when ${PLACEHOLDER_CONDITION} then null else ${effective} end)`;
}

/**
 * The scope, refusing rather than widening.
 *
 * `scopedRecordCondition` answers `undefined` for the three roles that read
 * everything and throws for every other role that is missing its code — so an
 * undefined here can only mean a global reader. Asserting that rather than
 * assuming it is the same defensiveness `getSalesDashboard` applies: "no
 * condition" means "no filter", and one misrouted caller would otherwise turn a
 * team leader's page into a report on the whole company.
 */
function viewerScope(viewer: SessionUser): SQL | undefined {
  const scope = scopedRecordCondition(viewer);
  if (!scope && !GLOBAL_READ_ROLES.includes(viewer.role)) {
    throw new AuthzError('FORBIDDEN', 'This account has no scope to report on');
  }
  return scope;
}

export type PerformanceQuery = {
  viewer: SessionUser;
  rung: PerformanceRung;
  /** `null` or omitted reports across every period. */
  periodId?: string | null;
};

/**
 * One grouped query per report, plus one tiny roster read for manager names.
 *
 * The names cannot come out of the grouped query at the TL and ACM rungs: the
 * sheet's `tl_name` describes whoever the sheet thought the rep's manager was,
 * and once an override has moved that rep it is a different person's name. The
 * roster map is keyed by CODE, so it survives the override the same way
 * `resolveHierarchy` does — and it is a few hundred rows either way.
 */
export async function loadPerformance(query: PerformanceQuery): Promise<PerformanceReport> {
  const { viewer, rung, periodId } = query;

  const where = and(
    viewerScope(viewer),
    periodId ? eq(salesRecord.periodId, periodId) : undefined,
  );

  const key = keyExpression(rung);
  const name: SQL<string | null> =
    rung === 'sm'
      ? sql<string | null>`max(coalesce(${manpower.smName}, ${salesRecord.smName}))`
      : sql<string | null>`null::text`;

  const [raw, names] = await Promise.all([
    db
      .select({
        code: sql<string | null>`${key}`,
        placeholder: sql<boolean>`${PLACEHOLDER_CONDITION}`,
        name,
        logins: countAll,
        issued: countFiltered(ISSUED_CONDITION),
        refused: countFiltered(REFUSED_CONDITION),
        unclassified: countFiltered(UNCLASSIFIED_CONDITION),
        // `::text` rather than letting the driver decide: an empty group would
        // otherwise be null and every consumer would need its own coalesce.
        anp: sql<string>`coalesce(sum(${salesRecord.anp}), 0)::text`,
        fp: sql<string>`coalesce(sum(${salesRecord.fp}), 0)::text`,
      })
      .from(salesRecord)
      .leftJoin(manpower, eq(manpower.smId, salesRecord.smId))
      .leftJoin(manpowerOverride, eq(manpowerOverride.smId, salesRecord.smId))
      .where(where)
      // GROUP BY the output ORDINALS of the first two columns, not by repeating
      // the expressions. Postgres matches a grouped expression to a selected one
      // structurally, and both of these carry bound parameters — restated in the
      // GROUP BY they bind as $9/$10 against the SELECT's $1/$2, which are
      // different parse nodes, and the planner rejects the whole query with
      // "sm_id must appear in the GROUP BY clause". `1, 2` are `code` and
      // `placeholder`; adding a column above them means changing these numbers.
      .groupBy(sql`1`, sql`2`),

    rung === 'sm' ? Promise.resolve(new Map<string, string | null>()) : managerNames(rung),
  ]);

  const rows: PerformanceRow[] = [];
  const placeholders: PerformanceRow[] = [];

  for (const row of raw) {
    const entry: PerformanceRow = {
      code: row.code,
      name: row.name ?? (row.code ? (names.get(row.code) ?? null) : null),
      placeholder: row.placeholder,
      logins: row.logins,
      issued: row.issued,
      refused: row.refused,
      // The remainder, not `count(*) filter (status = 'PENDING')`. That is what
      // makes issued + refused + pending = logins hold by construction.
      pending: row.logins - row.issued - row.refused,
      unclassified: row.unclassified,
      anp: row.anp,
      fp: row.fp,
    };
    (row.placeholder ? placeholders : rows).push(entry);
  }

  // Biggest book first, and the unplaced bucket last whatever its size: it is
  // not a competitor in a ranking, it is a gap to close.
  rows.sort((a, b) => {
    if ((a.code === null) !== (b.code === null)) return a.code === null ? 1 : -1;
    return b.logins - a.logins;
  });
  placeholders.sort((a, b) => b.logins - a.logins);

  return { rung, rows, placeholders, totals: sumMetrics([...rows, ...placeholders]) };
}

/** `tl_id`/`ccm_id` → the roster's name for that code. */
async function managerNames(rung: 'tl' | 'acm'): Promise<Map<string, string | null>> {
  const code = rung === 'tl' ? manpower.tlId : manpower.ccmId;
  const label = rung === 'tl' ? manpower.tlName : manpower.ccmName;

  const rows = await db
    .select({ code, name: sql<string | null>`max(${label})` })
    .from(manpower)
    .where(isNotNull(code))
    .groupBy(code);

  return new Map(rows.map((row) => [row.code as string, row.name]));
}

/* ------------------------------------------------------- one rep's standing */

export type RepStanding = {
  own: PerformanceMetrics;
  /** The whole team's figures — never the peers' individual rows. */
  team: PerformanceMetrics;
  /** Reps the roster places on that team, placeholders excluded. */
  teamSize: number;
  tlId: string | null;
  tlName: string | null;
};

/**
 * A rep's own numbers and where they sit in their team.
 *
 * The team is resolved from the ROSTER against the caller's own SM_ID and is
 * never taken as an argument. A `tlCode` parameter here would be a scope a
 * sales user could type into a URL, and the whole point of this function is
 * that a rep sees their team's total and average without ever seeing another
 * rep's individual row.
 */
export async function loadRepStanding(
  viewer: SessionUser,
  periodId?: string | null,
): Promise<RepStanding> {
  if (!viewer.smId) throw new AuthzError('FORBIDDEN', 'This account carries no SM_ID');

  const period = periodId ? eq(salesRecord.periodId, periodId) : undefined;
  const node = await resolveHierarchy(viewer.smId);
  const tlId = node?.tlId ?? null;

  const [own, team, teamSize] = await Promise.all([
    aggregate(and(viewerScope(viewer), period)),
    tlId
      ? aggregate(and(sql`${salesRecord.smId} in ${teamSmIds('tl_id', tlId)}`, period))
      : aggregate(and(viewerScope(viewer), period)),
    tlId ? rosterTeamSize(tlId) : Promise.resolve(node ? 1 : 0),
  ]);

  return { own, team, teamSize, tlId, tlName: node?.tlName ?? null };
}

/** The same five figures, ungrouped. */
async function aggregate(where: SQL | undefined): Promise<PerformanceMetrics> {
  const [row] = await db
    .select({
      logins: countAll,
      issued: countFiltered(ISSUED_CONDITION),
      refused: countFiltered(REFUSED_CONDITION),
      unclassified: countFiltered(UNCLASSIFIED_CONDITION),
      anp: sql<string>`coalesce(sum(${salesRecord.anp}), 0)::text`,
      fp: sql<string>`coalesce(sum(${salesRecord.fp}), 0)::text`,
    })
    .from(salesRecord)
    .where(where);

  return {
    logins: row.logins,
    issued: row.issued,
    refused: row.refused,
    pending: row.logins - row.issued - row.refused,
    unclassified: row.unclassified,
    anp: row.anp,
    fp: row.fp,
  };
}

/**
 * How many reps the roster puts on this team.
 *
 * The roster, not `count(distinct sm_id)` over the records: a rep who logged
 * nothing this month is still on the team, and an average that quietly dropped
 * them would flatter every team with somebody idle on it.
 */
async function rosterTeamSize(tlId: string): Promise<number> {
  const placeholders = sql.join(
    PLACEHOLDER_CODE_LIST.map((code) => sql`${code}`),
    sql`, `,
  );

  const [row] = await db
    .select({ total: sql<number>`cast(count(*) as integer)` })
    .from(manpower)
    .leftJoin(manpowerOverride, eq(manpowerOverride.smId, manpower.smId))
    .where(
      sql`coalesce(${manpowerOverride.tlId}, ${manpower.tlId}) = ${tlId}
          and upper(btrim(${manpower.smId})) not in (${placeholders})`,
    );

  return row?.total ?? 0;
}
