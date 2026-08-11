'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { removeUsersAction } from '@/lib/users/actions';
import type { BulkRemovalOutcome } from '@/lib/users/service';
import type { ActionResult } from '@/lib/result';
import { Alert, Button, Input, buttonClass } from '@/components/ui';

/**
 * Selecting several accounts and removing them.
 *
 * Deliberately NOT a `<form>`, though it posts one. Each row already carries its
 * own form for activate/deactivate, and a form inside a form is invalid HTML that
 * React refuses to hydrate — the browser drops the inner one, so the row buttons
 * silently stop working. The selection lives in React state and the FormData is
 * built when the action is called, which also means the checkboxes need no
 * hidden-field plumbing to survive a re-render.
 *
 * Blunt about what will happen. An account with audit history cannot be deleted
 * — the trail's actor is a restricted foreign key and this system exists to keep
 * that trail — so it is deactivated instead, and the confirmation says so before
 * the click rather than the result explaining it after.
 */
export function BulkRemove({
  children,
  selectableIds,
  onSelectionChange,
}: {
  children: ReactNode;
  selectableIds: string[];
  onSelectionChange?: (selected: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [state, setState] = useState<ActionResult<BulkRemovalOutcome> | null>(null);
  const [pending, startTransition] = useTransition();

  const needsTypedConfirm = selected.length > 10;

  function update(next: string[]) {
    setSelected(next);
    onSelectionChange?.(next);
  }

  function toggle(id: string, checked: boolean) {
    update(checked ? [...selected, id] : selected.filter((x) => x !== id));
  }

  function submit() {
    const form = new FormData();
    for (const id of selected) form.append('userId', id);
    if (needsTypedConfirm) form.set('confirm', typed.trim());

    startTransition(async () => {
      const result = await removeUsersAction(null, form);
      setState(result);
      if (result.ok) {
        update([]);
        setConfirming(false);
        setTyped('');
      }
    });
  }

  const allSelected = selected.length > 0 && selected.length === selectableIds.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={allSelected}
            // Indeterminate is the honest state for a partial selection and
            // cannot be expressed through `checked` alone.
            ref={(el) => {
              if (el) el.indeterminate = selected.length > 0 && !allSelected;
            }}
            onChange={(event) => update(event.currentTarget.checked ? selectableIds : [])}
          />
          Select all on this page
        </label>

        {selected.length > 0 ? (
          <span className="text-sm text-slate-600">{selected.length} selected</span>
        ) : null}

        {selected.length > 0 && !confirming ? (
          <button
            type="button"
            className={buttonClass('danger', 'text-sm')}
            onClick={() => setConfirming(true)}
          >
            Remove selected
          </button>
        ) : null}
      </div>

      {/*
        The rows render from the server component; the checkbox each one shows is
        wired through this context so the table stays a plain table.
      */}
      <BulkSelectionContext.Provider value={{ selected, toggle }}>
        {children}
      </BulkSelectionContext.Provider>

      {confirming && selected.length > 0 ? (
        <Alert tone="warning">
          <div className="space-y-3">
            <p>
              Removing {selected.length} account{selected.length === 1 ? '' : 's'}. Anyone who has
              already done something auditable is <strong>deactivated</strong> rather than deleted —
              their entries in the audit log have to survive. The rest are deleted outright.
            </p>

            {needsTypedConfirm ? (
              <label className="block text-sm">
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
              <Button type="button" variant="danger" onClick={submit} disabled={pending}>
                {pending ? 'Removing…' : `Yes, remove ${selected.length}`}
              </Button>
              <button
                type="button"
                className={buttonClass('secondary')}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </Alert>
      ) : null}

      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}

      {state?.ok ? (
        <Alert tone="success">
          <ul className="space-y-1 text-sm">
            {state.data.deleted.length > 0 ? (
              <li>
                Deleted {state.data.deleted.length}: {state.data.deleted.join(', ')}
              </li>
            ) : null}
            {state.data.deactivated.map((row) => (
              <li key={row.email}>
                Deactivated {row.email} — {row.reason}. Remove it from its own row to force it.
              </li>
            ))}
            {/* The bulk action never sets `force` — it is a per-account decision
                that has to be read one account at a time. The group is rendered
                anyway so the shape of the outcome is the same everywhere. */}
            {state.data.forced.map((row) => (
              <li key={row.email}>
                Removed {row.email} — {row.deletedAuditRows} audit entr
                {row.deletedAuditRows === 1 ? 'y' : 'ies'} deleted with it.
              </li>
            ))}
            {state.data.skipped.map((row) => (
              <li key={row.email}>
                Left alone {row.email} — {row.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ context */

import { createContext, useContext } from 'react';

const BulkSelectionContext = createContext<{
  selected: string[];
  toggle: (id: string, checked: boolean) => void;
} | null>(null);

/**
 * The per-row checkbox.
 *
 * A client component of its own so the table itself stays a server-rendered
 * table — the alternative was making the whole users page a client component to
 * hold one boolean per row.
 */
export function BulkSelectCheckbox({ id, label }: { id: string; label: string }) {
  const ctx = useContext(BulkSelectionContext);
  if (!ctx) return null;

  return (
    <input
      type="checkbox"
      aria-label={`Select ${label}`}
      checked={ctx.selected.includes(id)}
      onChange={(event) => ctx.toggle(id, event.currentTarget.checked)}
    />
  );
}
