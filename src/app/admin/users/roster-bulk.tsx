'use client';

import { useState, useTransition } from 'react';
import {
  provisionRosterAccountsAction,
  removeRosterEntriesAction,
} from '@/lib/users/actions';
import type { RosterProvisionOutcome, RosterRemovalOutcome } from '@/lib/users/service';
import { RUNG_LABELS, type RosterRung } from '@/lib/roster/entries';
import type { ActionResult } from '@/lib/result';
import { orDash } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  LinkButton,
  Table,
  Td,
  Th,
  buttonClass,
  type BadgeTone,
} from '@/components/ui';

/**
 * The provisioning worklist, with bulk account creation and roster removal.
 *
 * Every row comes from the Manpower sheet, at the rung the sheet puts that
 * person on — an area manager is offered an ACM login, not a rep's. See
 * src/lib/roster/entries.ts for how the rungs are derived.
 *
 * Deliberately NOT a `<form>`, matching `bulk-remove.tsx`: the selection lives
 * in React state and the FormData is built at submit, so the per-row "Assign
 * now" link cannot end up nested inside a form React refuses to hydrate. It also
 * means the checkboxes survive a re-render with no hidden-field plumbing.
 *
 * This component owns the empty state too, so that it stays mounted when the
 * last worklist row is provisioned away. The credentials below are the only copy
 * of those passwords in existence — a parent that swapped this whole subtree for
 * an EmptyState the moment the list emptied would take them with it.
 */

export type RosterCandidate = {
  /** `rung:code` — one person can hold two rungs, so the code alone is not an id. */
  key: string;
  code: string;
  name: string | null;
  rung: RosterRung;
  /** Lower rungs the sheet also names this code at — one login covers all of them. */
  alsoRungs: RosterRung[];
  location: string | null;
  parentCode: string | null;
  reports: number;
};

const RUNG_TONE: Record<RosterRung, BadgeTone> = {
  acm: 'info',
  tl: 'warning',
  sales: 'neutral',
};

const PARENT_LABEL: Record<RosterRung, string> = {
  acm: '—',
  tl: 'Area manager',
  sales: 'Team leader',
};

/** Rows rendered at once. The rest are reachable through the search box. */
const VISIBLE = 25;

/** Code, name, the manager they report to, and the rung's own word for itself. */
function matches(entry: RosterCandidate, needle: string): boolean {
  if (!needle) return true;
  return [entry.code, entry.name, entry.parentCode, entry.location, RUNG_LABELS[entry.rung]].some(
    (field) => field?.toLowerCase().includes(needle),
  );
}

export function RosterBulkProvision({ entries }: { entries: RosterCandidate[] }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<'create' | 'remove' | null>(null);
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [created, setCreated] = useState<ActionResult<RosterProvisionOutcome> | null>(null);
  const [removed, setRemoved] = useState<ActionResult<RosterRemovalOutcome> | null>(null);
  const [pending, startTransition] = useTransition();

  const needle = query.trim().toLowerCase();
  const found = entries.filter((entry) => matches(entry, needle));
  const shown = found.slice(0, VISIBLE);

  const selectable = shown.map((entry) => entry.key);
  // Against what is on screen, so the box does not sit checked while 200 rows
  // the search has hidden are also selected.
  const allSelected = selectable.length > 0 && selectable.every((key) => selected.includes(key));

  // Creating in bulk is confirmed only above a threshold; removing is confirmed
  // at any size, because the roster row it deletes comes back only with another
  // import of the sheet that carried it.
  const needsTypedConfirm = confirming === 'remove' || selected.length > 10;

  function toggle(key: string, checked: boolean) {
    setSelected(checked ? [...selected, key] : selected.filter((x) => x !== key));
  }

  function reset() {
    setSelected([]);
    setConfirming(null);
    setTyped('');
  }

  function submit(intent: 'create' | 'remove') {
    const form = new FormData();
    for (const key of selected) form.append('key', key);
    if (needsTypedConfirm) form.set('confirm', typed.trim());

    startTransition(async () => {
      if (intent === 'create') {
        const result = await provisionRosterAccountsAction(null, form);
        setCreated(result);
        if (result.ok) reset();
        return;
      }

      const result = await removeRosterEntriesAction(null, form);
      setRemoved(result);
      if (result.ok) reset();
    });
  }

  return (
    <div className="space-y-4">
      {entries.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search code, name, manager or location"
            aria-label="Search the provisioning worklist"
            className="w-full sm:w-80"
            autoComplete="off"
          />
          <span className="text-[13px] text-slate-600">
            {found.length === entries.length
              ? `${entries.length} waiting for an account`
              : `${found.length} of ${entries.length} match`}
          </span>
        </div>
      ) : null}

      {selectable.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={allSelected}
              // Indeterminate is the honest state for a partial selection and
              // cannot be expressed through `checked` alone.
              ref={(el) => {
                if (el) el.indeterminate = selected.length > 0 && !allSelected;
              }}
              onChange={(event) =>
                setSelected(
                  event.currentTarget.checked
                    ? [...new Set([...selected, ...selectable])]
                    : selected.filter((key) => !selectable.includes(key)),
                )
              }
            />
            Select all shown
          </label>

          {found.length > selectable.length ? (
            // The point of the search box: narrow to a team, an area or a rung,
            // then take every match rather than the page of them on screen.
            <button
              type="button"
              className={buttonClass('secondary', 'text-[13px]')}
              onClick={() => setSelected(found.map((entry) => entry.key))}
            >
              Select all {found.length}
              {needle ? ' matching' : ''}
            </button>
          ) : null}

          {selected.length > 0 ? (
            <span className="text-[13px] text-slate-600">{selected.length} selected</span>
          ) : null}

          {selected.length > 0 && confirming === null ? (
            <>
              <button
                type="button"
                className={buttonClass('primary', 'text-[13px]')}
                onClick={() => setConfirming('create')}
              >
                Create accounts
              </button>
              <button
                type="button"
                className={buttonClass('danger', 'text-[13px]')}
                onClick={() => setConfirming('remove')}
              >
                Remove from roster
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <EmptyState
          title="Everybody on the Manpower sheet has an account"
          description="New people appear here after the next roster import."
        />
      ) : shown.length === 0 ? (
        <EmptyState
          title={`Nothing on the worklist matches “${query.trim()}”`}
          description="The search covers the code, the name, the manager they report to, the location and the rung."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>
                <span className="sr-only">Select</span>
              </Th>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Rung</Th>
              <Th>Reports to</Th>
              <Th className="text-right">Under them</Th>
              <Th>Location</Th>
              <Th>
                <span className="sr-only">Action</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={entry.key}>
                <Td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${entry.code}`}
                    checked={selected.includes(entry.key)}
                    onChange={(event) => toggle(entry.key, event.currentTarget.checked)}
                  />
                </Td>
                <Td className="font-mono whitespace-nowrap">{entry.code}</Td>
                <Td>{orDash(entry.name)}</Td>
                <Td>
                  <Badge tone={RUNG_TONE[entry.rung]}>{RUNG_LABELS[entry.rung]}</Badge>
                  {/* One person, one login, at the rung that outranks the other.
                      Stated on the row because the sheet says both, and an admin
                      comparing the two would otherwise read the missing rung as
                      a person the worklist had lost. */}
                  {entry.alsoRungs.length > 0 ? (
                    <span className="mt-0.5 block text-[11px] text-slate-500">
                      also {entry.alsoRungs.map((r) => RUNG_LABELS[r].toLowerCase()).join(', ')} on
                      the sheet
                    </span>
                  ) : null}
                </Td>
                <Td className="font-mono text-[12px] whitespace-nowrap text-slate-600">
                  {entry.parentCode ? (
                    <>
                      <span className="sr-only">{PARENT_LABEL[entry.rung]} </span>
                      {entry.parentCode}
                    </>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td className="text-right tabular-nums">
                  {entry.rung === 'sales' ? '—' : entry.reports}
                </Td>
                <Td className="text-[12px] text-slate-600">{orDash(entry.location)}</Td>
                <Td>
                  <LinkButton
                    href={`/admin/users?code=${encodeURIComponent(entry.code)}&rung=${entry.rung}#create-account`}
                    variant="secondary"
                    className="px-2.5 py-1 text-[12px]"
                  >
                    Assign now
                  </LinkButton>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {found.length > shown.length ? (
        <p className="text-[12px] text-slate-500">
          Showing the first {shown.length} of {found.length}. Area managers and team leaders are
          listed first — a rep&rsquo;s account is worth little until somebody exists to approve
          their corrections. Search to reach the rest, or select all {found.length} and create them
          in one go.
        </p>
      ) : null}

      {confirming === 'create' && selected.length > 0 ? (
        <Alert tone="warning">
          <div className="space-y-3">
            <p>
              Creating {selected.length} account{selected.length === 1 ? '' : 's'}. Each signs in as{' '}
              <span className="font-mono">&lt;rung&gt;.&lt;code&gt;@bajajlife.com</span> with a
              generated password shown <strong>once</strong>, on this screen, and stored nowhere —
              copy them before you leave the page. The role and the scoping code come from the
              Manpower sheet, not from this table, so a code the sheet has since moved is refused
              rather than created at the wrong rung.
            </p>

            {/* ponytail: accounts are created one at a time server-side and each
                one hashes a password, so a few hundred takes tens of seconds.
                Said out loud rather than engineered around; batch the action if
                the roster ever grows past what one request can carry. */}
            {selected.length > 50 ? (
              <p>
                {selected.length} at once will take a little while — each password is hashed
                individually. Leave the page open until the table of credentials appears.
              </p>
            ) : null}

            {needsTypedConfirm ? (
              <label className="block text-[13px]">
                Type <strong>{selected.length}</strong> to confirm
                <Input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  className="mt-1 w-32"
                  autoComplete="off"
                />
              </label>
            ) : null}

            <div className="flex gap-2">
              <Button type="button" onClick={() => submit('create')} disabled={pending}>
                {pending ? 'Creating…' : `Yes, create ${selected.length}`}
              </Button>
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Alert>
      ) : null}

      {confirming === 'remove' && selected.length > 0 ? (
        <Alert tone="danger" title={`Remove ${selected.length} from the Manpower roster`}>
          <div className="space-y-3">
            <p>
              This deletes the roster row itself — the row every approval chain resolves against —
              and the only way back is to import a sheet that carries the code again. Use it for the
              rows that are not people: a channel, a partner, a bucket for business nobody has
              claimed. Anyone who still has people reporting to them, or who already holds an
              account, is refused rather than removed.
            </p>
            <p>
              Imported records stay exactly as they are. They simply become business nobody on the
              roster owns, which is what the code meant in the first place.
            </p>

            <label className="block text-[13px]">
              Type <strong>{selected.length}</strong> to confirm
              <Input
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                className="mt-1 w-32"
                autoComplete="off"
              />
            </label>

            <div className="flex gap-2">
              <Button type="button" onClick={() => submit('remove')} disabled={pending}>
                {pending ? 'Removing…' : `Yes, remove ${selected.length}`}
              </Button>
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => setConfirming(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Alert>
      ) : null}

      {created && !created.ok ? <Alert tone="danger">{created.error}</Alert> : null}
      {removed && !removed.ok ? <Alert tone="danger">{removed.error}</Alert> : null}

      {created?.ok && created.data.created.length > 0 ? (
        <Alert tone="success" title="Copy these now — the passwords are stored nowhere.">
          <div className="mt-2">
            <Table>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Rung</Th>
                  <Th>Email</Th>
                  <Th>Password</Th>
                  <Th>Name</Th>
                </tr>
              </thead>
              <tbody>
                {created.data.created.map((account) => (
                  <tr key={`${account.rung}:${account.code}`}>
                    <Td className="font-mono whitespace-nowrap">{account.code}</Td>
                    <Td>
                      <Badge tone={RUNG_TONE[account.rung]}>{RUNG_LABELS[account.rung]}</Badge>
                    </Td>
                    <Td className="font-mono break-all text-[12px]">{account.email}</Td>
                    <Td className="font-mono whitespace-nowrap select-all">{account.password}</Td>
                    <Td>{account.name}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Alert>
      ) : null}

      {created?.ok && created.data.refused.length > 0 ? (
        <Alert
          tone="warning"
          title={`Refused ${created.data.refused.length} — no account created.`}
        >
          <ul className="mt-1 space-y-1 text-[13px]">
            {created.data.refused.map((row) => (
              <li key={row.key}>
                <span className="font-mono">{row.code}</span> — {row.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {removed?.ok && removed.data.removed.length > 0 ? (
        <Alert
          tone="success"
          title={`Removed ${removed.data.removed.length} from the Manpower roster.`}
        >
          <ul className="mt-1 space-y-1 text-[13px]">
            {removed.data.removed.map((row) => (
              <li key={`${row.rung}:${row.code}`}>
                <span className="font-mono">{row.code}</span>
                {row.name ? ` (${row.name})` : ''} — {RUNG_LABELS[row.rung]}
                {row.recordsLeft > 0
                  ? `. ${row.recordsLeft} imported record${row.recordsLeft === 1 ? '' : 's'} now belong to nobody on the roster.`
                  : '.'}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {removed?.ok && removed.data.refused.length > 0 ? (
        <Alert tone="warning" title={`Kept ${removed.data.refused.length} — not removed.`}>
          <ul className="mt-1 space-y-1 text-[13px]">
            {removed.data.refused.map((row) => (
              <li key={row.key}>
                <span className="font-mono">{row.code}</span> — {row.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}
