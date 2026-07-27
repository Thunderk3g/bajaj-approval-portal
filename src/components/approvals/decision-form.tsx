'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Field, Textarea } from '@/components/ui';
import {
  approveRequestAction,
  rejectRequestAction,
  returnRequestAction,
} from '@/lib/approvals/actions';
import type { Decision } from '@/lib/approvals/schemas';

/**
 * The only client component in this slice.
 *
 * Everything else on the decision screen is a Server Component: the comparison,
 * the proofs and the timeline are reads, and marking them client would ship the
 * whole record to the browser bundle for no interaction. This form is the one
 * place that needs pending state and an inline result.
 */

const LABELS: Record<Decision, string> = {
  APPROVE: 'Approve and apply',
  REJECT: 'Reject',
  RETURN: 'Return for more information',
};

export function DecisionForm({
  requestId,
  /** Shown before the approver commits — e.g. an SM_ID missing from the roster. */
  caution,
}: {
  requestId: string;
  caution?: string | null;
}) {
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remarkErrors, setRemarkErrors] = useState<string[] | undefined>(undefined);
  const [success, setSuccess] = useState<{ title: string; warnings: string[] } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(decision: Decision) {
    setError(null);
    setRemarkErrors(undefined);

    // Requiredness is checked again on the server; this only saves a round trip.
    if (decision !== 'APPROVE' && remarks.trim() === '') {
      setRemarkErrors(['Remarks are required so the submitter knows what to change.']);
      return;
    }

    const formData = new FormData();
    formData.set('requestId', requestId);
    formData.set('remarks', remarks);

    startTransition(async () => {
      if (decision === 'APPROVE') {
        const result = await approveRequestAction(formData);
        if (!result.ok) {
          setError(result.error);
          setRemarkErrors(result.fieldErrors?.remarks);
          return;
        }
        setSuccess({
          title: `Applied — ${result.data.fieldLabel} is now "${result.data.newValue ?? '(empty)'}" as version ${result.data.appliedVersion}.`,
          warnings: result.data.warnings,
        });
      } else {
        const action = decision === 'REJECT' ? rejectRequestAction : returnRequestAction;
        const result = await action(formData);
        if (!result.ok) {
          setError(result.error);
          setRemarkErrors(result.fieldErrors?.remarks);
          return;
        }
        setSuccess({
          title:
            result.data.status === 'REJECTED'
              ? 'Rejected. The submitter has been notified.'
              : 'Returned to the submitter, who can edit and resubmit on this same request.',
          warnings: [],
        });
      }

      setRemarks('');
      router.refresh();
    });
  }

  if (success) {
    return (
      <div className="space-y-3">
        <Alert tone="success" title={success.title} />
        {success.warnings.map((w) => (
          <Alert key={w} tone="warning">
            {w}
          </Alert>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {caution ? <Alert tone="warning">{caution}</Alert> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Field
        label="Remarks"
        htmlFor="remarks"
        hint="Optional when approving. Required when rejecting or returning."
        error={remarkErrors}
      >
        <Textarea
          id="remarks"
          name="remarks"
          value={remarks}
          maxLength={2000}
          disabled={pending}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="What did you check, or what does the submitter need to change?"
        />
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={pending} onClick={() => submit('APPROVE')}>
          {pending ? 'Working…' : LABELS.APPROVE}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={pending}
          onClick={() => submit('RETURN')}
        >
          {LABELS.RETURN}
        </Button>
        <Button type="button" variant="danger" disabled={pending} onClick={() => submit('REJECT')}>
          {LABELS.REJECT}
        </Button>
      </div>

      <p className="text-xs text-slate-500">
        Approving writes a new version of the record and cannot be undone from here — the previous
        value stays on the version history.
      </p>
    </div>
  );
}
