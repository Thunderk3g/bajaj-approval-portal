'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { decideStageAction } from '@/lib/workflows/decide-action';
import { Alert, Button, Field, Textarea, buttonClass } from '@/components/ui';

/**
 * A manager's decision on the rung in front of them.
 *
 * Two buttons, not three. A team leader or area manager sitting mid-chain may
 * pass the request on or send it back for more information; rejecting outright
 * belongs to the final step alone, because that is the one that applies the
 * change and therefore the only one whose "no" is the end of the matter.
 */
export function ManagerDecisionForm({
  requestId,
  stageKey,
  role,
  caution,
}: {
  requestId: string;
  stageKey: string;
  /**
   * `admin` is here because a rung that resolves to nobody — no roster
   * placement, or a manager with no account — is decidable only by an
   * administrator (`assertMayDecide`), and until now nothing in the product
   * offered them that decision. They have no queue of their own, so they go back
   * to the corrections list instead.
   */
  role: 'tl' | 'acm' | 'admin';
  caution: string | null;
}) {
  const router = useRouter();
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * Kept apart from `error`, as on the verifier's and approver's forms.
   *
   * "You have not typed remarks" is a fact about the box directly above the
   * buttons, and rendering it as a banner put it where nothing points at the
   * control that has to change — a reader with the textarea in view gets a red
   * panel somewhere else on the card. `Field` renders it under the input and
   * the two states have different lifetimes: a server refusal clears on the
   * next attempt, this one clears the moment the field is filled in.
   */
  const [remarkErrors, setRemarkErrors] = useState<string[] | undefined>(undefined);
  const [pending, startTransition] = useTransition();

  function decide(decision: 'ADVANCE' | 'RETURN') {
    setError(null);
    setRemarkErrors(undefined);

    // Required on a return and only on a return: the rep has to know what to
    // change, and demanding a note to approve would train everyone to type "ok".
    if (decision === 'RETURN' && !remarks.trim()) {
      setRemarkErrors(['Say what needs to change — the rep only sees this note.']);
      return;
    }

    startTransition(async () => {
      const result = await decideStageAction({ requestId, decision, remarks: remarks.trim() || null });
      if (!result.ok) {
        setError(result.error);
        setRemarkErrors(result.fieldErrors?.remarks);
        return;
      }
      router.push(role === 'admin' ? '/admin/corrections' : `/${role}/queue`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {caution ? <Alert tone="warning">{caution}</Alert> : null}

      <Field
        label="Remarks"
        htmlFor="remarks"
        hint="Required when you send it back. Optional when you pass it on."
        error={remarkErrors}
      >
        <Textarea
          id="remarks"
          value={remarks}
          onChange={(event) => setRemarks(event.target.value)}
          disabled={pending}
          rows={3}
        />
      </Field>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {/* Stacked and full width, matching the verifier's and approver's forms:
          all three now render in the same narrow sticky rail. */}
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          className="w-full"
          onClick={() => decide('ADVANCE')}
          disabled={pending}
        >
          {pending ? 'Working…' : `Approve as ${stageKey}`}
        </Button>
        <button
          type="button"
          className={buttonClass('secondary', 'w-full')}
          onClick={() => decide('RETURN')}
          disabled={pending}
        >
          Send back for more information
        </button>
      </div>

      <p className="text-[11px] leading-snug text-slate-500">
        Passing it on moves the request to the next rung; it does not write the record. Only the
        final rung applies the change.
      </p>
    </div>
  );
}
