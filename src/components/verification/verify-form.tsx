'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Field, Textarea } from '@/components/ui';
import {
  returnFromVerificationAction,
  verifyRequestAction,
} from '@/lib/verification/actions';
import type { VerifierDecision } from '@/lib/verification/schemas';

/**
 * The verifier's decision form — 2026-07-28 spec section 3.
 *
 * Two buttons, not three. There is no Reject: a verifier's "no" returns the
 * request to the rep with remarks, which is the answer they can act on. Only an
 * approver can kill a request outright, and the copy below says so rather than
 * leaving a verifier hunting for a button that does not exist.
 */

const LABELS: Record<VerifierDecision, string> = {
  VERIFY: 'Verify and send to approver',
  RETURN: 'Return for more information',
};

export function VerifyForm({
  requestId,
  /** Shown before committing — e.g. no proof attached, or the record has moved on. */
  caution,
}: {
  requestId: string;
  caution?: string | null;
}) {
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [remarkErrors, setRemarkErrors] = useState<string[] | undefined>(undefined);
  const [success, setSuccess] = useState<{ title: string; warning: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function submit(decision: VerifierDecision) {
    setError(null);
    setRemarkErrors(undefined);

    // Checked again on the server; this only saves a round trip.
    if (decision === 'RETURN' && remarks.trim() === '') {
      setRemarkErrors(['Remarks are required so the submitter knows what to change.']);
      return;
    }

    const formData = new FormData();
    formData.set('requestId', requestId);
    formData.set('remarks', remarks);

    startTransition(async () => {
      const action = decision === 'VERIFY' ? verifyRequestAction : returnFromVerificationAction;
      const result = await action(formData);

      if (!result.ok) {
        setError(result.error);
        setRemarkErrors(result.fieldErrors?.remarks);
        return;
      }

      setSuccess(
        result.data.status === 'VERIFIED'
          ? {
              title: 'Verified. It is now in the approver queue.',
              // A verified request nobody is subscribed to is a request that
              // stops here. The verifier is the last person in a position to
              // notice, so they are the one told.
              warning:
                result.data.notified === 0
                  ? 'No active approver account exists, so nobody was notified. Ask an administrator to create one — this request cannot be approved until they do.'
                  : null,
            }
          : {
              title: 'Returned to the submitter, who can edit and resubmit on this same request.',
              warning: null,
            },
      );

      setRemarks('');
      router.refresh();
    });
  }

  if (success) {
    return (
      <div className="space-y-3">
        <Alert tone="success" title={success.title} />
        {success.warning ? <Alert tone="warning">{success.warning}</Alert> : null}
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
        hint="Optional when verifying — useful to record what you checked. Required when returning."
        error={remarkErrors}
      >
        <Textarea
          id="remarks"
          name="remarks"
          value={remarks}
          maxLength={2000}
          disabled={pending}
          onChange={(e) => setRemarks(e.target.value)}
          placeholder="What did you check against the proof, or what does the submitter need to change?"
        />
      </Field>

      {/* Stacked and full width: this form sits in the decision screen's narrow
          sticky rail, where a wrapping row gives two buttons of different sizes. */}
      <div className="flex flex-col gap-2">
        <Button type="button" className="w-full" disabled={pending} onClick={() => submit('VERIFY')}>
          {pending ? 'Working…' : LABELS.VERIFY}
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          disabled={pending}
          onClick={() => submit('RETURN')}
        >
          {LABELS.RETURN}
        </Button>
      </div>

      <p className="text-[11px] leading-snug text-slate-500">
        Verifying does not change the record — it passes the request to an approver, who applies
        it. If this correction should not go ahead at all, return it with a reason; only an
        approver can reject a request outright.
      </p>
    </div>
  );
}
