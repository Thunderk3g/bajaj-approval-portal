import { Alert, EmptyState } from '@/components/ui';
import type { BatchCoverage, CoverageGroup, CoverageTeam } from '@/lib/hierarchy/coverage';

/**
 * The batch's policies as bubbles, grouped area manager → team leader → rep.
 *
 * A server component and a `<details>` element, not a client component with a
 * chart library. Expanding a group is the only interaction here, `<details>`
 * does it natively with no JavaScript shipped and no hydration, and the two
 * things a chart library would give us — a layout solver and an axis — are
 * things this chart does not have. Sizes are `sqrt(policies)`: area is what the
 * eye compares, so a bubble twice the width is four times the business.
 *
 * The house has no charting dependency and hand-rolls (see the drag-and-drop
 * note in admin/hierarchy/hierarchy-tree.tsx); this stays that way.
 */

/** Widest bubble a team can reach, in px, and the smallest a team can shrink to. */
const TEAM_MIN = 44;
const TEAM_SPAN = 68;
const REP_MIN = 22;
const REP_SPAN = 30;

/**
 * Diameter for a count, scaled against the biggest count on the page.
 *
 * `sqrt` because a circle's area grows with the square of its diameter — sizing
 * the diameter linearly would show a team with twice the policies as four times
 * the ink, which is the classic way a bubble chart lies.
 */
function diameter(policies: number, max: number, min: number, span: number): number {
  if (max <= 0) return min;
  return Math.round(min + span * Math.sqrt(policies / max));
}

const fmt = (n: number) => n.toLocaleString('en-IN');

/** "Sunil P (TL001)", or just the code when the sheet carries no name. */
function label(name: string | null, code: string | null, fallback: string): string {
  if (!code) return fallback;
  return name ? `${name} (${code})` : code;
}

export function HierarchyBubbles({ coverage }: { coverage: BatchCoverage }) {
  const { groups, orphans, totals } = coverage;

  if (totals.policies === 0) {
    return (
      <EmptyState
        title="No records from this upload"
        description="Nothing was written to the master records under this batch, so there is nothing to place on the hierarchy."
      />
    );
  }

  // One scale for the whole page, taken from the largest team and the largest
  // rep anywhere in it. Scaling each group to its own maximum would make the
  // biggest bubble in a 12-policy area manager the same size as the biggest in
  // a 1,200-policy one.
  const maxTeam = Math.max(1, ...groups.flatMap((g) => g.teams.map((t) => t.policies)));
  const maxRep = Math.max(
    1,
    ...groups.flatMap((g) => g.teams.flatMap((t) => t.reps.map((r) => r.policies))),
  );

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-5">
        <Stat label="Policies" value={fmt(totals.policies)} />
        <Stat label="Area managers" value={fmt(totals.acms)} />
        <Stat label="Team leaders" value={fmt(totals.tls)} />
        <Stat label="Reps" value={fmt(totals.reps)} />
        <Stat
          label="Not attributable"
          value={fmt(totals.unattributed)}
          tone={totals.unattributed > 0 ? 'warning' : 'default'}
        />
      </dl>

      {groups.length === 0 ? (
        <EmptyState
          title="Nothing in this upload reached the roster"
          description="Every code the file carries is a placeholder or absent from the Manpower sheet. Import an up-to-date roster and the chart will fill in."
        />
      ) : (
        <ul className="space-y-2">
          {groups.map((group, index) => (
            <li key={group.acmId ?? 'unplaced'}>
              <Group group={group} maxTeam={maxTeam} maxRep={maxRep} defaultOpen={index === 0} />
            </li>
          ))}
        </ul>
      )}

      {orphans.length > 0 ? <Orphans orphans={orphans} /> : null}
    </div>
  );
}

function Group({
  group,
  maxTeam,
  maxRep,
  defaultOpen,
}: {
  group: CoverageGroup;
  maxTeam: number;
  maxRep: number;
  defaultOpen: boolean;
}) {
  const reps = group.teams.reduce((n, t) => n + t.reps.length, 0);
  const name = label(group.acmName, group.acmId, 'No area manager on the roster');

  return (
    <details open={defaultOpen} className="rounded-[6px] border border-slate-200 bg-white">
      {/* The whole summary is the hit target, and `cursor-pointer` is the only
          affordance a native disclosure gets for free. */}
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-2 text-[13px] hover:bg-slate-50">
        <span className="font-medium text-slate-900">{name}</span>
        <span className="text-slate-500">
          {group.teams.length} {group.teams.length === 1 ? 'team leader' : 'team leaders'} ·{' '}
          {reps} {reps === 1 ? 'rep' : 'reps'}
        </span>
        <span className="ml-auto font-semibold tabular-nums text-slate-900">
          {fmt(group.policies)} <span className="font-normal text-slate-500">policies</span>
        </span>
      </summary>

      <ul className="flex flex-wrap gap-3 border-t border-slate-100 p-3">
        {group.teams.map((team) => (
          <li key={team.tlId ?? 'unplaced'}>
            <Team team={team} maxTeam={maxTeam} maxRep={maxRep} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function Team({ team, maxTeam, maxRep }: { team: CoverageTeam; maxTeam: number; maxRep: number }) {
  const size = diameter(team.policies, maxTeam, TEAM_MIN, TEAM_SPAN);
  const name = label(team.tlName, team.tlId, 'No team leader');

  return (
    <div className="flex w-[190px] flex-col items-center gap-2 rounded-[6px] border border-slate-200 bg-slate-50/60 p-3">
      <div
        // Inline width/height rather than a Tailwind class: the value is data.
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-sky-100 text-[12px] font-semibold tabular-nums text-sky-900 ring-1 ring-sky-300"
        title={`${name} — ${fmt(team.policies)} policies across ${team.reps.length} reps`}
      >
        {fmt(team.policies)}
      </div>

      <div className="text-center">
        <p className="text-[12px] font-medium text-slate-900">{name}</p>
        <p className="text-[11px] text-slate-500">
          {team.reps.length} {team.reps.length === 1 ? 'rep' : 'reps'}
        </p>
      </div>

      <ul className="flex flex-wrap justify-center gap-1">
        {team.reps.map((rep) => {
          const repSize = diameter(rep.policies, maxRep, REP_MIN, REP_SPAN);
          const who = rep.smName ? `${rep.smName} (${rep.smId})` : rep.smId;
          return (
            <li
              key={rep.smId}
              style={{ width: repSize, height: repSize }}
              className="flex items-center justify-center rounded-full bg-slate-200 text-[10px] tabular-nums text-slate-700 ring-1 ring-slate-300"
              title={`${who} — ${fmt(rep.policies)} policies`}
            >
              {/* Below ~28px the number does not fit; the title carries it, and
                  the bubble is still doing its job as a mark of size. */}
              <span className={repSize >= 28 ? '' : 'sr-only'}>{fmt(rep.policies)}</span>
              <span className="sr-only">{who}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Orphans({ orphans }: { orphans: BatchCoverage['orphans'] }) {
  const total = orphans.reduce((n, o) => n + o.policies, 0);
  const placeholders = orphans.filter((o) => o.placeholder);

  return (
    <Alert
      tone="warning"
      title={`${fmt(total)} ${total === 1 ? 'policy' : 'policies'} under ${orphans.length} ${
        orphans.length === 1 ? 'code' : 'codes'
      } that name no rep`}
    >
      <p>
        {placeholders.length > 0 ? (
          <>
            <span className="font-mono">{placeholders.map((o) => o.smId).join(', ')}</span>{' '}
            {placeholders.length === 1 ? 'is a bucket' : 'are buckets'} the source file uses for
            business with nobody attached — digital-channel sales and issuance no rep has claimed.
            They are counted here and deliberately kept off the hierarchy.{' '}
          </>
        ) : null}
        Any remaining code owns real policies but has no{' '}
        <span className="font-medium">Manpower</span> row, so no team leader or area manager can be
        asked about them — the roster sheet is what is stale, not the data.
      </p>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs">
        {orphans.map((orphan) => (
          <li key={orphan.smId}>
            {orphan.smId} <span className="tabular-nums">{fmt(orphan.policies)}</span>
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function Stat({
  label: text,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
        {text}
      </dt>
      <dd
        className={
          tone === 'warning'
            ? 'mt-0.5 text-lg font-semibold tabular-nums text-amber-700'
            : 'mt-0.5 text-lg font-semibold tabular-nums text-slate-900'
        }
      >
        {value}
      </dd>
    </div>
  );
}
