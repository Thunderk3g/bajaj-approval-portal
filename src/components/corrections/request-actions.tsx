'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  resubmitCorrectionAction,
  withdrawCorrectionAction,
} from '@/lib/corrections/actions';
import type { FieldErrors } from '@/lib/result';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';

/**
 * The two things a submitter can still do to an open request — spec section 7.
 *
 * Neither passes an owner or a status. The request id is the only input, and
 * the server re-reads both facts from the row before acting: a form field
 * saying "this is mine" is a claim by whoever submitted the form.
 */

type ResubmitProps = {
  requestId: string;
  category: string;
  /** MAPPING only — decides whether the destination stays editable. Null elsewhere. */
  direction: string | null;
  fieldLabel: string;
  currentValue: string;
  currentDescription: string;
  accept: string;
  issuedDateMin: string;
  issuedDateMax: string;
  attachmentsRemaining: number;
};

export function ResubmitForm({
  requestId,
  category,
  direction,
  fieldLabel,
  currentValue,
  currentDescription,
  accept,
  issuedDateMin,
  issuedDateMax,
  attachmentsRemaining,
}: ResubmitProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await resubmitCorrectionAction(form);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      router.refresh();
    });
  }

  return (
    <Card
      title="Resubmit"
      description="The approver asked for a change. Editing here keeps the request and its history intact."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <input type="hidden" name="requestId" value={requestId} />

        <Field label={fieldLabel} htmlFor="proposedValue" required error={fieldErrors.proposedValue}>
          {category === 'AUTOPAY' ? (
            <Select id="proposedValue" name="proposedValue" defaultValue={currentValue}>
              <option value="Yes">Yes</option>
              <option value="No">No</option>
            </Select>
          ) : category === 'ISSUANCE_DATE' ? (
            <Input
              id="proposedValue"
              name="proposedValue"
              type="date"
              min={issuedDateMin}
              max={issuedDateMax}
              defaultValue={currentValue}
            />
          ) : (
            /*
              A mapping value is read-only for a CLAIM_IN and editable for a
              TRANSFER_OUT — 2026-07-29 spec section 2.

              A claim's destination is the submitter's own SM_ID, pinned by the
              server, so an editable box would only invite a value that gets
              refused. A transfer's destination is another rep, and "you named
              the wrong rep" is one of the likeliest reasons a verifier returns
              one — so it is exactly the field that has to be changeable here.
            */
            <Input
              id="proposedValue"
              name="proposedValue"
              defaultValue={currentValue}
              readOnly={direction === 'CLAIM_IN'}
              className={category === 'MAPPING' ? 'font-mono' : undefined}
            />
          )}
        </Field>

        <Field
          label="Description"
          htmlFor="resubmit-description"
          required={category === 'OTHERS'}
          error={fieldErrors.description}
        >
          <Textarea
            id="resubmit-description"
            name="description"
            defaultValue={currentDescription}
            maxLength={2000}
          />
        </Field>

        <Field
          label="Add more proof"
          htmlFor="resubmit-files"
          error={fieldErrors.files}
          hint={
            attachmentsRemaining > 0
              ? `Optional. You can add ${attachmentsRemaining} more document${attachmentsRemaining === 1 ? '' : 's'}.`
              : 'This request already holds the maximum number of documents.'
          }
        >
          <input
            id="resubmit-files"
            name="files"
            type="file"
            multiple
            accept={accept}
            disabled={attachmentsRemaining === 0}
            className="block w-full text-[13px] text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-white hover:file:bg-slate-800 disabled:opacity-60"
          />
        </Field>

        <Button type="submit" disabled={pending}>
          {pending ? 'Resubmitting…' : 'Resubmit for approval'}
        </Button>
      </form>
    </Card>
  );
}

export function WithdrawButton({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const form = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await withdrawCorrectionAction(form);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setConfirming(false);
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <Button type="button" variant="secondary" className="w-full" onClick={() => setConfirming(true)}>
        Withdraw this request
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <input type="hidden" name="requestId" value={requestId} />

      <Field label="Why are you withdrawing this?" htmlFor="reason">
        <Input id="reason" name="reason" placeholder="Optional" maxLength={2000} />
      </Field>

      <p className="text-[11px] leading-snug text-slate-600">
        Withdrawing closes the request and releases the field, so you can raise a corrected one.
        The request and its history stay on the record.
      </p>

      <div className="flex gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          {pending ? 'Withdrawing…' : 'Confirm withdrawal'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
          Keep it open
        </Button>
      </div>
    </form>
  );
}
