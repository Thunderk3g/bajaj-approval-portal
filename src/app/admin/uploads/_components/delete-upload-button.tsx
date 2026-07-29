'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteBatchAction } from '@/lib/import/actions';
import { Alert, Button } from '@/components/ui';

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
 * `committed` is passed in so a committed batch shows the reason it cannot be
 * deleted instead of a button that always fails. The server refuses it anyway;
 * this is the explanation, not the control.
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

  if (committed) return null;

  async function run() {
    setPending(true);
    setError(null);

    const result = await deleteBatchAction({ batchId });

    if (!result.ok) {
      setPending(false);
      setConfirming(false);
      setError(result.error);
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
            Delete upload
          </Button>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        {warning ? <Alert tone="warning">{warning}</Alert> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
      <p className="text-sm text-red-900">
        Delete <span className="font-medium">{fileName}</span>? This removes the stored workbook from
        disk, every row staged from it, and any leads it imported. It cannot be undone.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="danger" onClick={() => void run()} disabled={pending}>
          {pending ? 'Deleting…' : 'Delete permanently'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
