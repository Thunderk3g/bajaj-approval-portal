'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  clearRepOverrideAction,
  moveRepToTeamAction,
  moveTeamToManagerAction,
  type TeamNode,
} from '@/lib/hierarchy/actions';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  buttonClass,
  cx,
} from '@/components/ui';

/**
 * Restructuring the reporting line by dragging — 2026-08-06 spec section 5.
 *
 * Two drags, and they are not the same operation. A rep dropped on a team moves
 * that one person. A team dropped on an area manager takes every rep under it,
 * because a rep reports upward THROUGH their team leader — leaving them behind
 * would split one team across two cluster heads, which the roster has no shape
 * for. The team move therefore asks first and names the number of people it is
 * about to move; the rep move does not, because its blast radius is the row you
 * are already holding.
 *
 * The rep's area manager is never asked for. It follows from the team they land
 * in — every TL sits under exactly one ACM across the whole roster — and offering
 * the two as independent choices would let an admin build a pairing the source
 * data has no row for, routing two mapping approvals to people who do not work
 * together.
 *
 * Native HTML5 drag and drop rather than a library, for the same reason as the
 * chain editor: the whole interaction is a handful of event handlers, against a
 * dependency that would outweigh the screen it serves. And for the same reason
 * as the chain editor, every drag has a button-and-select twin — dragging is
 * unreachable by keyboard and silent to a screen reader, so it is the shortcut
 * on top of the accessible path, never the only way through.
 */

export type UnplacedRep = { smId: string; smName: string | null };

type Rep = TeamNode['reps'][number];

/** What is currently in the hand. The kind decides which targets light up. */
type Held = { kind: 'rep'; smId: string } | { kind: 'team'; tlId: string };

const LABEL = 'text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500';
const SMALL = 'px-2 py-1 text-[11px]';

export function HierarchyTree({
  initial,
  unplaced,
}: {
  initial: TeamNode[];
  unplaced: UnplacedRep[];
}) {
  const router = useRouter();
  const [teams, setTeams] = useState(initial);
  const [loose, setLoose] = useState(unplaced);
  const [seed, setSeed] = useState(initial);
  const [held, setHeld] = useState<Held | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openRep, setOpenRep] = useState<string | null>(null);
  const [openTeam, setOpenTeam] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ tlId: string; acmId: string } | null>(null);
  const [pending, startTransition] = useTransition();

  // The tree lives in state so a drop can show its result before the server has
  // agreed. Every successful write ends in `router.refresh()`, and this is what
  // lets the fresh props win over the optimistic copy — without it the screen
  // would drift from the database the moment two administrators edited at once.
  if (seed !== initial) {
    setSeed(initial);
    setTeams(initial);
    setLoose(unplaced);
    setConfirm(null);
  }

  const groups = groupByAcm(teams);
  const acmCodes = [...new Set(teams.map((t) => t.acmId).filter(isCode))].sort();

  // Searching narrows what is DRAWN, never what is in `teams`: the "Move…"
  // dropdown below has to keep offering every team, or a filtered screen could
  // only ever move somebody onto the team they were already looking at.
  const needle = query.trim().toLowerCase();
  const shownGroups = needle ? groups.map(narrow(needle)).filter((g) => g.teams.length > 0) : groups;
  const shownLoose = needle ? loose.filter((rep) => hit(needle, rep.smId, rep.smName)) : loose;
  const shownTeams = shownGroups.reduce((n, g) => n + g.teams.length, 0);

  /* ------------------------------------------------------------- mutations */

  // One move at a time. Both of these keep a snapshot to revert to, and a second
  // move starting before the first has answered would revert to a tree that no
  // longer describes the database.
  function moveRep(smId: string, tlId: string) {
    if (pending) return;

    const source = teams.find((t) => t.reps.some((r) => r.smId === smId));
    if (source?.tlId === tlId) return;

    const placed = source?.reps.find((r) => r.smId === smId);
    const rep = placed ?? loose.find((r) => r.smId === smId);
    if (!rep || !teams.some((t) => t.tlId === tlId)) return;

    const before = teams;
    const beforeLoose = loose;

    const landed: Rep = {
      smId: rep.smId,
      smName: rep.smName,
      overridden: true,
      // Only a rep the sheet placed somewhere has a sheet team to differ from.
      sheetTlId: placed?.sheetTlId ?? null,
    };

    setOpenRep(null);
    setError(null);
    setTeams(
      teams.map((team) =>
        team.tlId === tlId
          ? { ...team, reps: [...team.reps, landed].sort((a, b) => a.smId.localeCompare(b.smId)) }
          : { ...team, reps: team.reps.filter((r) => r.smId !== smId) },
      ),
    );
    setLoose(loose.filter((r) => r.smId !== smId));

    startTransition(async () => {
      const result = await moveRepToTeamAction({ smId, tlId });
      if (!result.ok) {
        setTeams(before);
        setLoose(beforeLoose);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function moveTeam(tlId: string, acmId: string) {
    if (pending) return;

    const before = teams;
    // The name of the manager being moved TO, taken from a team already sitting
    // under them. An unprovisioned ACM has no name anywhere, and inventing one
    // from the code would read as a person.
    const acmName = teams.find((t) => t.acmId === acmId)?.acmName ?? null;

    setConfirm(null);
    setOpenTeam(null);
    setError(null);
    setTeams(
      teams.map((team) =>
        team.tlId === tlId
          ? {
              ...team,
              acmId,
              acmName,
              // The move writes one override row per rep, not one for the team —
              // a TL exists only as a code on their reps' rows — so every rep in
              // it is now pinned, and each says so.
              reps: team.reps.map((r) => ({ ...r, overridden: true })),
            }
          : team,
      ),
    );

    startTransition(async () => {
      const result = await moveTeamToManagerAction({ tlId, acmId });
      if (!result.ok) {
        setTeams(before);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function release(smId: string) {
    setError(null);
    startTransition(async () => {
      const result = await clearRepOverrideAction({ smId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Nothing optimistic here. Dropping the override sends the rep back to
      // whatever the sheet says, which may be a team on the other side of the
      // screen or no team at all — only the server knows where they land.
      router.refresh();
    });
  }

  /* ---------------------------------------------------------------- pieces */

  function repRow(rep: Rep, team: TeamNode | null) {
    const drifted = Boolean(team && rep.sheetTlId && rep.sheetTlId !== team.tlId);
    const open = openRep === rep.smId;

    return (
      <li
        key={rep.smId}
        draggable
        onDragStart={(event) => {
          // Firefox refuses to start a drag on a plain element until the
          // dataTransfer carries something; the payload itself is unused,
          // because the handlers read `held` instead.
          event.dataTransfer.setData('text/plain', rep.smId);
          setHeld({ kind: 'rep', smId: rep.smId });
        }}
        onDragEnd={() => {
          setHeld(null);
          setOver(null);
        }}
        className={cx(
          'rounded-md border px-2 py-1',
          team ? 'border-slate-200 bg-white' : 'border-amber-200 bg-amber-50',
          held?.kind === 'rep' && held.smId === rep.smId ? 'opacity-40' : '',
        )}
      >
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span aria-hidden className="cursor-grab select-none leading-none text-slate-400">
            ⠿
          </span>
          <span className="font-mono text-slate-900">{rep.smId}</span>
          <span className="text-slate-600">{rep.smName ?? '—'}</span>
          {rep.overridden ? <Badge tone="info">overridden</Badge> : null}
          {drifted ? (
            <Badge tone="warning">
              sheet says <span className="font-mono">{rep.sheetTlId}</span>
            </Badge>
          ) : null}

          <span className="ml-auto flex items-center gap-1">
            <button
              type="button"
              className={buttonClass('ghost', SMALL)}
              onClick={() => setOpenRep(open ? null : rep.smId)}
              aria-expanded={open}
            >
              {open ? 'Cancel' : 'Move…'}
            </button>
            {rep.overridden ? (
              <button
                type="button"
                className={buttonClass('ghost', SMALL)}
                onClick={() => release(rep.smId)}
                disabled={pending}
                title="Drop the override and follow the Manpower sheet again"
              >
                Release
              </button>
            ) : null}
          </span>
        </div>

        {open ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
            <label htmlFor={`move-${rep.smId}`} className={LABEL}>
              Move {rep.smId} to team
            </label>
            <div className="w-72">
              <Select
                id={`move-${rep.smId}`}
                defaultValue=""
                disabled={pending}
                onChange={(event) => moveRep(rep.smId, event.target.value)}
              >
                <option value="" disabled>
                  Choose a team…
                </option>
                {groups.map((group) => (
                  <optgroup key={group.acmId ?? 'none'} label={group.acmId ?? 'No area manager'}>
                    {group.teams.map((t) => (
                      <option key={t.tlId} value={t.tlId} disabled={t.tlId === team?.tlId}>
                        {t.tlId}
                        {t.tlName ? ` · ${t.tlName}` : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </div>
            <span className="text-[12px] text-slate-500">
              Their area manager follows the team.
            </span>
          </div>
        ) : null}
      </li>
    );
  }

  function teamCard(team: TeamNode) {
    const target = `team:${team.tlId}`;
    const open = openTeam === team.tlId;
    const asking = confirm?.tlId === team.tlId ? confirm : null;

    return (
      <div
        key={team.tlId}
        onDragOver={(event) => {
          if (held?.kind !== 'rep') return;
          // Without preventDefault the browser refuses the drop outright — the
          // default for most elements is "not a drop target".
          event.preventDefault();
          setOver(target);
        }}
        onDragLeave={() => setOver((current) => (current === target ? null : current))}
        onDrop={(event) => {
          if (held?.kind !== 'rep') return;
          event.preventDefault();
          moveRep(held.smId, team.tlId);
          setHeld(null);
          setOver(null);
        }}
        className={cx(
          'rounded-md border bg-white p-3 transition',
          over === target ? 'border-slate-900 ring-1 ring-slate-900' : 'border-slate-200',
          held?.kind === 'team' && held.tlId === team.tlId ? 'opacity-40' : '',
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('text/plain', team.tlId);
              setHeld({ kind: 'team', tlId: team.tlId });
            }}
            onDragEnd={() => {
              setHeld(null);
              setOver(null);
            }}
            aria-hidden
            title="Drag the team onto another area manager"
            className="cursor-grab select-none leading-none text-slate-400"
          >
            ⠿
          </span>
          <span className="font-mono text-[13px] font-medium text-slate-900">{team.tlId}</span>
          <span className="text-[13px] text-slate-600">{team.tlName ?? '—'}</span>
          {team.location ? (
            <span className="text-[12px] text-slate-500">{team.location}</span>
          ) : null}
          <Badge tone="neutral">
            {team.reps.length} rep{team.reps.length === 1 ? '' : 's'}
          </Badge>

          <span className="ml-auto">
            <button
              type="button"
              className={buttonClass('ghost', SMALL)}
              onClick={() => setOpenTeam(open ? null : team.tlId)}
              aria-expanded={open}
            >
              {open ? 'Cancel' : 'Move team…'}
            </button>
          </span>
        </div>

        {open && !asking ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 p-2">
            <label htmlFor={`move-team-${team.tlId}`} className={LABEL}>
              Move {team.tlId} to area manager
            </label>
            <div className="w-72">
              <Select
                id={`move-team-${team.tlId}`}
                defaultValue=""
                disabled={pending}
                onChange={(event) => setConfirm({ tlId: team.tlId, acmId: event.target.value })}
              >
                <option value="" disabled>
                  Choose an area manager…
                </option>
                {acmCodes.map((code) => (
                  <option key={code} value={code} disabled={code === team.acmId}>
                    {code}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        ) : null}

        {asking ? (
          <div className="mt-2 space-y-2">
            <Alert tone="warning" title={`Move ${team.tlId} to ${asking.acmId}?`}>
              This moves {team.reps.length} rep{team.reps.length === 1 ? '' : 's'}. They keep{' '}
              <span className="font-mono">{team.tlId}</span> as their team leader and change area
              manager with them. Each one gets an override that survives the next import.
            </Alert>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => moveTeam(team.tlId, asking.acmId)}
                disabled={pending}
              >
                {pending
                  ? 'Moving…'
                  : `Move the team and ${team.reps.length} rep${team.reps.length === 1 ? '' : 's'}`}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setConfirm(null);
                  setOpenTeam(null);
                }}
                disabled={pending}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        <ul className="mt-2 space-y-1">{team.reps.map((rep) => repRow(rep, team))}</ul>
      </div>
    );
  }

  /* ----------------------------------------------------------------- render */

  return (
    <div className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {teams.length > 0 ? (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search SM_ID, name, team leader, area manager or location"
              aria-label="Search the hierarchy"
              className="w-full sm:w-96"
              autoComplete="off"
            />
            <span className="text-[13px] text-slate-600">
              {needle
                ? `${shownTeams} of ${teams.length} teams`
                : `${teams.length} teams · ${teams.reduce((n, t) => n + t.reps.length, 0)} reps`}
            </span>
            {needle ? (
              <button
                type="button"
                className={buttonClass('ghost', SMALL)}
                onClick={() => setQuery('')}
              >
                Clear
              </button>
            ) : null}
          </div>
          {needle ? (
            <p className="mt-2 text-[12px] text-slate-500">
              A team is shown whole when it matches, so a drop still moves the people you can see.
              Move… keeps offering every team, searched or not.
            </p>
          ) : null}
        </Card>
      ) : null}

      {shownLoose.length > 0 ? (
        <Card
          title="Under nobody"
          description="Drag one onto a team, or use Move…. Until then every team-leader and area-manager step on their corrections resolves to nobody and falls to the administrators."
        >
          {/* A rep nobody has placed has nothing to override and no sheet team
              to have drifted from, so they render as the same row with both
              facts flat rather than as a second kind of row. */}
          <ul className="space-y-1">
            {shownLoose.map((rep) => repRow({ ...rep, overridden: false, sheetTlId: null }, null))}
          </ul>
        </Card>
      ) : null}

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            title="No roster has been imported"
            description="Import a workbook containing a Manpower sheet. Until then no rep is placed under a manager, so every team-leader and area-manager approval step resolves to nobody."
          />
        </Card>
      ) : null}

      {groups.length > 0 && shownGroups.length === 0 && shownLoose.length === 0 ? (
        <Card>
          <EmptyState
            title={`Nobody on the roster matches “${query.trim()}”`}
            description="The search covers SM_IDs, rep names, team-leader and area-manager codes and names, and locations."
          />
        </Card>
      ) : null}

      {shownGroups.map((group) => {
        const target = `acm:${group.acmId ?? ''}`;
        const reps = group.teams.reduce((sum, t) => sum + t.reps.length, 0);

        return (
          <Card
            key={group.acmId ?? 'none'}
            className={cx(
              'transition',
              over === target ? 'border-slate-900 ring-1 ring-slate-900' : '',
            )}
            title={
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono">{group.acmId ?? '—'}</span>
                <span className="font-normal text-slate-600">{group.acmName ?? 'Area manager'}</span>
              </span>
            }
            description={
              group.acmId
                ? 'Drop a team here to move it — and everyone under it — to this area manager.'
                : 'These teams name no area manager, so their ACM approval step has nobody to route to.'
            }
            actions={
              <span className={LABEL}>
                {group.teams.length} team{group.teams.length === 1 ? '' : 's'} · {reps} rep
                {reps === 1 ? '' : 's'}
              </span>
            }
          >
            <div
              onDragOver={(event) => {
                // A team may only be dropped on a DIFFERENT manager: allowing the
                // one it already sits under would spend a confirmation and an
                // audit row on a no-op.
                if (held?.kind !== 'team' || !group.acmId) return;
                event.preventDefault();
                setOver(target);
              }}
              onDragLeave={() => setOver((current) => (current === target ? null : current))}
              onDrop={(event) => {
                if (held?.kind !== 'team' || !group.acmId) return;
                event.preventDefault();
                // Asks rather than moves. The number of people this carries is
                // the whole reason the operation exists, so it is shown before it
                // commits, not reported after.
                if (teams.find((t) => t.tlId === held.tlId)?.acmId !== group.acmId) {
                  setConfirm({ tlId: held.tlId, acmId: group.acmId });
                  setOpenTeam(null);
                }
                setHeld(null);
                setOver(null);
              }}
              className="space-y-2"
            >
              {group.teams.map(teamCard)}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------- utils */

function isCode(value: string | null): value is string {
  return Boolean(value);
}

/** True when any of these fields contains the (already lowercased) needle. */
function hit(needle: string, ...fields: Array<string | null>): boolean {
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * Keeps the teams a search should show, whole.
 *
 * Whole, not just the matching reps: a team is a drop target and its card is
 * what a rep is dragged onto, so a card rendered holding three of its eleven
 * people would be a target that lies about what it contains. Matching the area
 * manager keeps every team under them, which is what searching for a manager
 * means.
 */
function narrow(needle: string): (group: Group) => Group {
  return (group) => {
    if (hit(needle, group.acmId, group.acmName)) return group;
    return {
      ...group,
      teams: group.teams.filter(
        (team) =>
          hit(needle, team.tlId, team.tlName, team.location) ||
          team.reps.some((rep) => hit(needle, rep.smId, rep.smName)),
      ),
    };
  };
}

type Group = { acmId: string | null; acmName: string | null; teams: TeamNode[] };

/**
 * ACM → TL, from a list that is already sorted by ACM then TL.
 *
 * Insertion order is the display order, so an optimistic move drops the team at
 * the end of its new manager's list rather than jumping it into place. That is
 * the honest position until the refresh lands — and it keeps the team the eye
 * just followed visible where it stopped.
 */
function groupByAcm(teams: TeamNode[]): Group[] {
  const groups = new Map<string, Group>();

  for (const team of teams) {
    // A team is only real while somebody reports to it — a TL has no roster row
    // of their own — so one emptied by a drag disappears here, exactly as it
    // will on the next load.
    if (team.reps.length === 0) continue;

    const key = team.acmId ?? '';
    const group = groups.get(key) ?? { acmId: team.acmId, acmName: team.acmName, teams: [] };
    group.acmName ??= team.acmName;
    group.teams.push(team);
    groups.set(key, group);
  }

  return [...groups.values()];
}
