'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteBatchAction } from '@/lib/import/actions';
import { FORCE_DELETE_PHRASE } from '@/lib/import/delete-confirm';
import { Alert, Button, Input } from '@/components/ui';

/**
 * Deletes an upload, behind an inline confirmation.
 *
 * Two clicks rather than a `window.confirm`: the browser dialog cannot say what
 * is about to be removed, and "OK / Cancel" is the same two words whether the
 * batch is a test file or nine megabytes somebody spent an afternoon mapping.
 *
 * The confirmation names the file and states the three things that go with it,
 * because none of them is recoverable — the stored workbook is deleted from disk
 * and the only remaining trace is the audit entry.
 *
 * A COMMITTED batch can also be removed, but only by taking its records with it —
 * every record it created points back at it. That is a different act from
 * deleting a draft, so it gets different words, a red panel that names the record
 * count, and a typed confirmation. The server re-checks all of it; this is the
 * explanation, not the control.
 *
 * Approved corrections on those records stop the delete outright, and the way
 * past that is offered only AFTER the server has refused once — the override
 * appears in response to the refusal rather than beside the ordinary button, so
 * nobody reaches it without first reading what it destroys.
 */
export function DeleteUploadButton({
  batchId,
  fileName,
  committed = false,
  redirectTo,
  compact = false,
}: {
  batchId: string;
  fileName: string;
  committed?: boolean;
  /** Where to go after a successful delete. Omit to refresh in place. */
  redirectTo?: string;
  /** Table-row presentation: a small link-like control rather than a button. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  /** How many approved corrections the server said are in the way, once it has said so. */
  const [blockedBy, setBlockedBy] = useState<number | null>(null);
  /** The admin has asked for the override and is being shown the phrase box. */
  const [forcing, setForcing] = useState(false);
  const [phrase, setPhrase] = useState('');

  async function run() {
    setPending(true);
    setError(null);

    const result = await deleteBatchAction({
      batchId,
      purge: committed,
      confirm: committed ? typed.trim() : undefined,
      force: forcing || undefined,
      forceConfirm: forcing ? phrase.trim() : undefined,
    });

    if (!result.ok) {
      setPending(false);
      // The confirmation panel STAYS open on failure. The first attempt is
      // expected to fail — it is what asks for the record count — and closing
      // the panel would make the admin start again to read the number.
      setError(result.error);
      // The one refusal in this action that has a way past it says so with this
      // key. Reading the wording instead would put the rule in two places and
      // silently lose the override the first time somebody edits the sentence.
      const blocking = result.fieldErrors?.force?.[0];
      if (blocking) setBlockedBy(Number(blocking));
      return;
    }

    // Reported rather than swallowed. A file left behind is not a failure — the
    // upload is gone as far as the portal is concerned — but it is a fact an
    // admin cleaning up disk space needs, and it will never surface anywhere
    // else.
    if (!result.data.fileRemoved) {
      setWarning(
        'The upload was removed, but the stored workbook could not be deleted from disk. It is now orphaned.',
      );
    }

    if (redirectTo) {
      router.push(redirectTo);
      router.refresh();
      return;
    }

    setPending(false);
    setConfirming(false);
    setForcing(false);
    setBlockedBy(null);
    setPhrase('');
    router.refresh();
  }

  if (!confirming) {
    return (
      <div className={compact ? 'inline-flex flex-col items-start gap-1' : 'space-y-2'}>
        {compact ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="text-xs font-medium text-red-700 underline underline-offset-2 hover:text-red-900"
          >
            Delete
          </button>
        ) : (
          <Button type="button" variant="danger" onClick={() => setConfirming(true)}>
            {committed ? 'Delete the upload and its records' : 'Delete upload'}
          </Button>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {warning ? <Alert tone="warning">{warning}</Alert> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-[13px] leading-relaxed text-red-900">
        Delete <span className="font-medium">{fileName}</span>? This removes the stored workbook from
        disk, every row staged from it, any leads it imported, and the Manpower rows it wrote to the
        roster. Admin overrides on those people are kept and apply again on the next import.
        {committed ? (
          <>
            {' '}
            Because it was committed, <strong>every record it created goes with it</strong>, along
            with their version history and any open correction against them. It cannot be undone.
          </>
        ) : (
          ' It cannot be undone.'
        )}
      </p>

      {committed ? (
        <label className="block text-[13px] font-medium text-red-900">
          Type the record count shown below to confirm
          {/* The shared control, so the confirmation box is the same height and
              type size as every other input in the portal — only its border
              carries the warning. */}
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            className="mt-1.5 w-32 border-red-300 font-mono focus:border-red-500 focus:ring-red-500"
            autoComplete="off"
            inputMode="numeric"
          />
        </label>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {/* Offered only once the server has refused, and only for the refusal that
          can be overridden. The count comes from the server rather than from a
          query this component runs, so what the admin is told is the number the
          delete will actually erase. */}
      {blockedBy !== null && !forcing ? (
        <button
          type="button"
          onClick={() => setForcing(true)}
          className="text-[13px] font-medium text-red-700 underline underline-offset-2 hover:text-red-900"
        >
          Force delete
        </button>
      ) : null}

      {forcing ? (
        <label className="block text-[13px] font-medium text-red-900">
          Forcing this erases {blockedBy} approved correction{blockedBy === 1 ? '' : 's'} and the
          version{blockedBy === 1 ? '' : 's'} {blockedBy === 1 ? 'it' : 'they'} produced. The audit
          entry is all that survives. Type {FORCE_DELETE_PHRASE} to confirm.
          <Input
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            className="mt-1.5 w-56 border-red-300 font-mono uppercase focus:border-red-500 focus:ring-red-500"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="danger" onClick={() => void run()} disabled={pending}>
          {pending
            ? 'Deleting…'
            : forcing
              ? 'Delete permanently, erasing the approvals'
              : committed
                ? 'Delete permanently, with its records'
                : 'Delete permanently'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            // Everything the panel learned goes with it. Reopening it must start
            // from the ordinary delete again, not from an override already armed.
            setConfirming(false);
            setForcing(false);
            setBlockedBy(null);
            setPhrase('');
            setError(null);
          }}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
