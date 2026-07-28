'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button } from '@/components/ui';
import { closePeriodAction, reopenPeriodAction } from '@/lib/periods/actions';

/**
 * Close and reopen, with a confirmation step on close.
 *
 * Closing is the one action here that changes what OTHER people can do — every
 * rep loses the ability to raise new corrections against that month the instant
 * it lands — so it asks first and says exactly what is still in flight. Reopen
 * does not: it only ever restores capability.
 */
export function PeriodActions({
  periodId,
  label,
  status,
  openRequests,
}: {
  periodId: string;
  label: string;
  status: string;
  openRequests: number;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function run(action: typeof closePeriodAction | typeof reopenPeriodAction, closing: boolean) {
    setError(null);
    setNotice(null);

    const formData = new FormData();
    formData.set('periodId', periodId);

    startTransition(async () => {
      const result = await action(formData);
      if (!result.ok) {
        setError(result.error);
        setConfirming(false);
        return;
      }
      setConfirming(false);
      setNotice(
        closing
          ? `${label} is closed. No new corrections can be raised against its records; the ${openRequests} already open can still be completed.`
          : `${label} is open again.`,
      );
      router.refresh();
    });
  }

  if (notice) return <Alert tone="success">{notice}</Alert>;

  if (status === 'CLOSED') {
    return (
      <div className="space-y-2">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => run(reopenPeriodAction, false)}
        >
          {pending ? 'Working…' : 'Reopen'}
        </Button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="space-y-2">
        <Alert tone="warning" title={`Close ${label}?`}>
          Salespeople will no longer be able to raise <strong>new</strong> corrections against
          records in this cycle.
          {openRequests > 0 ? (
            <>
              {' '}
              The <strong>{openRequests}</strong> request{openRequests === 1 ? '' : 's'} already
              open can still be verified, approved and resubmitted — closing does not strand them.
            </>
          ) : (
            ' Nothing is currently in flight.'
          )}{' '}
          You can reopen it afterwards.
        </Alert>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={() => run(closePeriodAction, true)}
          >
            {pending ? 'Closing…' : `Close ${label}`}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
        Close period
      </Button>
    </div>
  );
}
