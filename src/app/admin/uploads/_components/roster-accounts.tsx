'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { provisionRosterAccountsAction } from '@/lib/users/actions';
import type { RosterProvisionOutcome } from '@/lib/users/service';
import { RUNG_LABELS, type RosterRung } from '@/lib/roster/entries';
import type { ActionResult } from '@/lib/result';
import { orDash } from '@/lib/format';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Input,
  Table,
  Td,
  Th,
  type BadgeTone,
} from '@/components/ui';

/**
 * Portal accounts for the people THIS workbook's roster introduced, created
 * without leaving the wizard.
 *
 * The gap this closes: committing the roster places a rep under a manager, but
 * it creates no login — and a mapping correction cannot route to a manager who
 * cannot sign in. Admins were importing the file, going to People, provisioning,
 * and importing the same file again to get the mapping they expected. The roster
 * is committed here, so the accounts are created here.
 *
 * The same action `/admin/users` uses, deliberately — one provisioning path, one
 * set of refusals, one place where a password is generated. This component only
 * decides which keys to send, and the server re-derives the role, the scope and
 * the address from the sheet regardless of what it is sent.
 *
 * Managers first, and grouped so that is visible rather than a sort order nobody
 * reads: a rep's account is worth little until the two rungs above them exist,
 * because a stage that resolves to nobody falls through to the administrators.
 */

export type RosterAccountRow = {
  /** `rung:code` — one code is one person, and the rung says which login. */
  key: string;
  code: string;
  name: string | null;
  rung: RosterRung;
  parentCode: string | null;
  location: string | null;
  /** Non-null once somebody can sign in with this code, from any screen. */
  accountEmail: string | null;
};

const RUNG_TONE: Record<RosterRung, BadgeTone> = {
  acm: 'info',
  tl: 'warning',
  sales: 'neutral',
};

/** Top of the hierarchy down — the order they have to be created in. */
const GROUPS: Array<{ rung: RosterRung; title: string; why: string }> = [
  {
    rung: 'acm',
    title: 'Area managers',
    why: 'Sign off mapping changes across their teams.',
  },
  {
    rung: 'tl',
    title: 'Team leaders',
    why: 'The first rung of every mapping chain. Without them the step falls through to the administrators.',
  },
  {
    rung: 'sales',
    title: 'Sales managers',
    why: 'See their own book and raise corrections against it.',
  },
];

/** The threshold `provisionRosterAccountsAction` asks to be typed back. */
const CONFIRM_ABOVE = 10;

export function RosterAccounts({ entries }: { entries: RosterAccountRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<ActionResult<RosterProvisionOutcome> | null>(null);
  const [pending, startTransition] = useTransition();

  const waiting = entries.filter((entry) => entry.accountEmail === null);
  const withAccounts = entries.length - waiting.length;

  const needsTypedConfirm = selected.length > CONFIRM_ABOVE;
  const confirmed = !needsTypedConfirm || typed.trim() === String(selected.length);

  function toggle(key: string, checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, key])] : current.filter((x) => x !== key),
    );
  }

  function toggleMany(keys: string[], checked: boolean) {
    setSelected((current) =>
      checked ? [...new Set([...current, ...keys])] : current.filter((x) => !keys.includes(x)),
    );
  }

  function create() {
    const form = new FormData();
    for (const key of selected) form.append('key', key);
    if (needsTypedConfirm) form.set('confirm', typed.trim());

    startTransition(async () => {
      const outcome = await provisionRosterAccountsAction(null, form);
      setResult(outcome);
      if (outcome.ok) {
        setSelected([]);
        setTyped('');
        // The count above, the step badge and the People screen all read the
        // rows this just wrote. The passwords below survive it — refreshing a
        // server component does not remount this subtree, which is the only
        // copy of them in existence.
        router.refresh();
      }
    });
  }

  // Nothing came off this workbook's Manpower sheet. Distinct from "everybody
  // has an account": there is no worklist to be at the end of.
  if (entries.length === 0) {
    return (
      <EmptyState
        title="This workbook's roster names nobody who can hold a login"
        description="Commit the Manpower sheet above first. If it is already committed, the sheet carries only placeholder codes — buckets and channels, not people."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-slate-600">
        <span className="font-medium text-slate-900">
          {withAccounts} of {entries.length}
        </span>{' '}
        roster {entries.length === 1 ? 'member has' : 'members have'} a portal account.
        {waiting.length > 0 ? (
          <>
            {' '}
            Accounts are what let a manager sign in and approve — a rung with no login routes to the
            administrators instead of to the person the sheet names.
          </>
        ) : null}
      </p>

      {waiting.length === 0 ? (
        <Alert tone="success" title="Everybody this workbook placed can sign in">
          Nothing to create here. Carry on to the sheet and the column mapping below — the mapping
          will resolve against these accounts.
        </Alert>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={selected.length === waiting.length && waiting.length > 0}
                ref={(el) => {
                  if (el) el.indeterminate = selected.length > 0 && selected.length < waiting.length;
                }}
                onChange={(event) =>
                  toggleMany(
                    waiting.map((entry) => entry.key),
                    event.currentTarget.checked,
                  )
                }
                disabled={pending}
              />
              Select all {waiting.length}
            </label>

            {selected.length > 0 ? (
              <span className="text-[13px] text-slate-600">{selected.length} selected</span>
            ) : null}

            {needsTypedConfirm ? (
              <label className="flex items-center gap-2 text-[13px]">
                Type <strong>{selected.length}</strong> to confirm
                <Input
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  className="w-24"
                  autoComplete="off"
                  aria-label={`Type ${selected.length} to confirm`}
                />
              </label>
            ) : null}

            <Button
              type="button"
              onClick={create}
              disabled={pending || selected.length === 0 || !confirmed}
            >
              {pending
                ? 'Creating…'
                : selected.length === 0
                  ? 'Create accounts'
                  : `Create ${selected.length} account${selected.length === 1 ? '' : 's'}`}
            </Button>
          </div>

          <p className="text-[12px] text-slate-500">
            Each signs in as <span className="font-mono">&lt;rung&gt;.&lt;code&gt;@bajajlife.com</span>{' '}
            with a generated password shown <strong>once</strong>, here, and stored nowhere. The role
            and the scoping code come from the Manpower sheet, not from this table.
          </p>

          {GROUPS.map((group) => {
            const rows = waiting.filter((entry) => entry.rung === group.rung);
            if (rows.length === 0) return null;

            const keys = rows.map((entry) => entry.key);
            const allSelected = keys.every((key) => selected.includes(key));

            return (
              <div key={group.rung} className="space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <h4 className="text-[13px] font-semibold text-slate-900">
                    {group.title} <span className="tabular-nums text-slate-500">({rows.length})</span>
                  </h4>
                  <span className="text-[12px] text-slate-500">{group.why}</span>
                </div>

                <Table>
                  <thead>
                    <tr>
                      <Th>
                        <input
                          type="checkbox"
                          aria-label={`Select all ${group.title.toLowerCase()}`}
                          checked={allSelected}
                          ref={(el) => {
                            if (el) {
                              el.indeterminate =
                                !allSelected && keys.some((key) => selected.includes(key));
                            }
                          }}
                          onChange={(event) => toggleMany(keys, event.currentTarget.checked)}
                          disabled={pending}
                        />
                      </Th>
                      <Th>Code</Th>
                      <Th>Name</Th>
                      <Th>Reports to</Th>
                      <Th>Location</Th>
                      <Th>Signs in as</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((entry) => (
                      <tr key={entry.key}>
                        <Td>
                          <input
                            type="checkbox"
                            aria-label={`Select ${entry.code}`}
                            checked={selected.includes(entry.key)}
                            onChange={(event) => toggle(entry.key, event.currentTarget.checked)}
                            disabled={pending}
                          />
                        </Td>
                        {/* Identifiers are text, never right-aligned numbers. */}
                        <Td className="font-mono whitespace-nowrap">{entry.code}</Td>
                        <Td>{orDash(entry.name)}</Td>
                        <Td className="font-mono text-[12px] whitespace-nowrap text-slate-600">
                          {orDash(entry.parentCode)}
                        </Td>
                        <Td className="text-[12px] text-slate-600">{orDash(entry.location)}</Td>
                        <Td className="font-mono text-[12px] break-all text-slate-500">
                          {entry.rung === 'sales' ? 'sm' : entry.rung}.{entry.code.toLowerCase()}
                          @bajajlife.com
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            );
          })}
        </>
      )}

      {result && !result.ok ? <Alert tone="danger">{result.error}</Alert> : null}

      {result?.ok && result.data.created.length > 0 ? (
        <Alert
          tone="success"
          title={`${result.data.created.length} account${result.data.created.length === 1 ? '' : 's'} created — copy these now, the passwords are stored nowhere.`}
        >
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
                {result.data.created.map((account) => (
                  <tr key={`${account.rung}:${account.code}`}>
                    <Td className="font-mono whitespace-nowrap">{account.code}</Td>
                    <Td>
                      <Badge tone={RUNG_TONE[account.rung]}>{RUNG_LABELS[account.rung]}</Badge>
                    </Td>
                    <Td className="font-mono break-all text-[12px] select-all">{account.email}</Td>
                    <Td className="font-mono whitespace-nowrap select-all">{account.password}</Td>
                    <Td>{account.name}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
          <p className="mt-2 text-[12px]">
            This is the only time they are shown. Nothing here or anywhere else can recover them —
            an account whose password is lost has to be given a new one on{' '}
            <span className="font-medium">People</span>.
          </p>
        </Alert>
      ) : null}

      {/* Named, never silently dropped. "Already has an account" is also the
          stale case: somebody provisioned that code from another screen after
          this list was drawn, and reloading is what makes the two agree. */}
      {result?.ok && result.data.refused.length > 0 ? (
        <Alert
          tone="warning"
          title={`${result.data.refused.length} refused — no account was created for ${result.data.refused.length === 1 ? 'it' : 'them'}.`}
        >
          <ul className="mt-1 space-y-1 text-[13px]">
            {result.data.refused.map((row) => (
              <li key={row.key}>
                <span className="font-mono">{row.code}</span> — {row.reason}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px]">
            A code that already has an account may have been provisioned elsewhere since this list
            was drawn. Reload the page to see it as it stands.
          </p>
        </Alert>
      ) : null}
    </div>
  );
}
