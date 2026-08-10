'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { lookupRecordAction, submitCorrectionAction } from '@/lib/corrections/actions';
import type { RecordLookupResult } from '@/lib/corrections/lookup';
import type { FieldErrors } from '@/lib/result';
import { Alert, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';

/**
 * The category-branching submission form.
 *
 * Everything this component knows about limits, accepted file types and field
 * choices arrives as a prop from the server page. That is not ceremony: the
 * modules those values live in reach for `node:fs` and `node:crypto`, and
 * importing them here would drag the filesystem layer into the browser bundle.
 * Passing them down keeps one source of truth on the server and ships a list of
 * strings to the client.
 *
 * Nothing here is a control. The `required` attributes, the Yes/No select and
 * the date bounds are conveniences that stop a rep submitting a form they will
 * be told off for; the Zod union on the server and the CHECK constraints in the
 * database are what actually decide (spec section 7.1).
 */

export type CategoryChoice = { value: string; label: string; hint: string };
export type FieldChoice = { value: string; label: string };

type Props = {
  smId: string;
  initialAppsNo: string;
  initialCategory: string;
  /** Only meaningful when the category is MAPPING; ignored otherwise. */
  initialDirection: 'CLAIM_IN' | 'TRANSFER_OUT';
  categories: CategoryChoice[];
  fieldChoices: FieldChoice[];
  accept: string;
  maxFiles: number;
  maxFileMb: number;
  issuedDateMin: string;
  issuedDateMax: string;
};

export function NewCorrectionForm({
  smId,
  initialAppsNo,
  initialCategory,
  initialDirection,
  categories,
  fieldChoices,
  accept,
  maxFiles,
  maxFileMb,
  issuedDateMin,
  issuedDateMax,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [category, setCategory] = useState(initialCategory);
  /**
   * Which way a mapping request moves the sale — 2026-07-29 spec section 2.
   *
   * Seeded from the URL so "Transfer to another SM" on a record page opens
   * straight onto the right direction; falls back to the claim, which is the
   * direction that existed before and the more common one — a rep notices a
   * sale missing from their book more often than one that should not be in it.
   *
   * Held here rather than read off the form on submit because three controls
   * below change shape with it — the identifier's label, whether a lookup is
   * offered, and whether the destination is the rep's own SM_ID or editable.
   */
  const [direction, setDirection] = useState<'CLAIM_IN' | 'TRANSFER_OUT'>(initialDirection);
  const [appsNo, setAppsNo] = useState(initialAppsNo);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const isMapping = category === 'MAPPING';
  const isTransfer = isMapping && direction === 'TRANSFER_OUT';
  const isClaim = isMapping && direction === 'CLAIM_IN';

  const [lookup, setLookup] = useState<RecordLookupResult | null>(null);
  const [lookupMessage, setLookupMessage] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const chosen = categories.find((c) => c.value === category);

  function runLookup() {
    setLookingUp(true);
    setLookupMessage(null);
    setLookup(null);

    startTransition(async () => {
      const result = await lookupRecordAction(appsNo);
      setLookingUp(false);

      if (!result.ok) {
        setLookupMessage(result.error);
        return;
      }

      if (!result.data.record) {
        setLookupMessage(`No record exists for application ${appsNo}.`);
        return;
      }

      setLookup(result.data.record);
      setLookupMessage(`${result.data.remaining} lookups left this hour.`);
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    const form = new FormData(event.currentTarget);

    startTransition(async () => {
      const result = await submitCorrectionAction(form);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      router.push(`/sales/requests/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {/*
        Carried as a hidden field rather than as the radios' own `name`, so it is
        absent from the FormData entirely on the other three categories. The
        `correction_direction_iff_mapping` CHECK rejects a direction on an
        AUTOPAY row, and a radio group that stayed mounted would send one.
      */}
      {isMapping ? <input type="hidden" name="direction" value={direction} /> : null}

      <Card title="What needs correcting">
        <div className="space-y-4">
          <Field label="Category" htmlFor="category" required hint={chosen?.hint}>
            <Select
              id="category"
              name="category"
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setLookup(null);
                setLookupMessage(null);
              }}
            >
              {categories.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </Field>

          {isMapping ? (
            <Field
              label="Which way is the sale moving?"
              required
              error={fieldErrors.direction}
              hint="Both go to the verifier and then the approver. The other rep is told as soon as you submit."
            >
              {/*
                Radios rather than a second dropdown. The two options are not
                variations on one setting — they start from opposite books and
                reverse who is giving and who is receiving — and a rep who picks
                the wrong one produces a request that is refused for a reason
                that will not obviously connect to the control they got wrong.
                Both choices being visible at once is what prevents that.
              */}
              <div className="space-y-2">
                <DirectionOption
                  value="CLAIM_IN"
                  checked={direction === 'CLAIM_IN'}
                  onSelect={setDirection}
                  title="This sale is mine"
                  detail="It is credited to another rep and should be in my book."
                />
                <DirectionOption
                  value="TRANSFER_OUT"
                  checked={direction === 'TRANSFER_OUT'}
                  onSelect={setDirection}
                  title="This sale belongs to someone else"
                  detail="It is in my book and should move to another rep."
                />
              </div>
            </Field>
          ) : null}

          <Field
            label={isTransfer ? 'Application or policy number' : 'Application number'}
            htmlFor="appsNo"
            required
            error={fieldErrors.appsNo}
            hint={
              isClaim
                ? 'Look the application up to confirm it is the sale you mean before you claim it.'
                : isTransfer
                  ? 'Either number works — the sale is already in your book, so it is found there.'
                  : undefined
            }
          >
            <div className="flex gap-2">
              <Input
                id="appsNo"
                name="appsNo"
                value={appsNo}
                onChange={(e) => setAppsNo(e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                placeholder="6167509575"
              />
              {/*
                Lookup is offered for a claim only. A transfer starts from a
                record the rep already owns and can already read, so the section
                7.2 exception — with its restricted projection and its 20-an-hour
                limit — has nothing to do: pointing it at your own book would
                spend a rate-limited cross-book read on a row you can open.
              */}
              {isClaim ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={runLookup}
                  disabled={lookingUp || appsNo.trim() === ''}
                  className="shrink-0"
                >
                  {lookingUp ? 'Looking up…' : 'Look up'}
                </Button>
              ) : null}
            </div>
          </Field>

          {isClaim && (lookup || lookupMessage) ? (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              {lookup ? (
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
                  <Pair label="Client" value={lookup.clientName} />
                  <Pair label="Product" value={lookup.productName} />
                  <Pair label="Status" value={lookup.status} />
                  <Pair label="Issued" value={lookup.issuedDate} />
                  <Pair label="Currently credited to" value={lookup.smName} />
                </dl>
              ) : null}
              {lookupMessage ? (
                <p className="mt-2 text-[11px] text-slate-500">{lookupMessage}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </Card>

      <Card title="The correction">
        <div className="space-y-4">
          {category === 'OTHERS' ? (
            <Field label="Field" htmlFor="fieldName" required error={fieldErrors.fieldName}>
              <Select id="fieldName" name="fieldName" defaultValue="">
                <option value="" disabled>
                  Choose a field…
                </option>
                {fieldChoices.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          <Field
            label={isMapping ? 'Move the sale to' : 'Corrected value'}
            htmlFor="proposedValue"
            required
            error={fieldErrors.proposedValue}
            hint={
              isClaim
                ? 'A mapping claim always moves the sale to you. The SM name is resolved from the Manpower roster when it is approved.'
                : isTransfer
                  ? 'The SM ID that should hold this sale. It must be in the Manpower roster — the SM name is resolved from there when it is approved.'
                  : undefined
            }
          >
            {category === 'AUTOPAY' ? (
              <Select id="proposedValue" name="proposedValue" defaultValue="Yes">
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </Select>
            ) : isTransfer ? (
              // Editable, and the only place in this form a rep names another
              // rep. The server checks it is not their own SM_ID and that the
              // roster knows it, so a typo is refused here rather than becoming
              // a reassignment to nobody.
              <Input
                id="proposedValue"
                name="proposedValue"
                autoComplete="off"
                className="font-mono uppercase"
                placeholder="C2CM21350"
              />
            ) : isMapping ? (
              // Read-only: the claimant's SM_ID is taken from the session, and
              // the server refuses a value that does not match it, so a claim
              // cannot be used to push a sale onto a third party (section 7.2).
              // Pushing one deliberately is the transfer above.
              <Input id="proposedValue" name="proposedValue" value={smId} readOnly className="font-mono" />
            ) : category === 'ISSUANCE_DATE' ? (
              <Input
                id="proposedValue"
                name="proposedValue"
                type="date"
                min={issuedDateMin}
                max={issuedDateMax}
              />
            ) : (
              <Input id="proposedValue" name="proposedValue" autoComplete="off" />
            )}
          </Field>

          <Field
            label="Description"
            htmlFor="description"
            required={category === 'OTHERS'}
            error={fieldErrors.description}
            hint={
              category === 'OTHERS'
                ? 'Required: say what is wrong and what the value should be.'
                : 'Optional context for the approver.'
            }
          >
            <Textarea id="description" name="description" maxLength={2000} />
          </Field>
        </div>
      </Card>

      <Card
        title="Proof"
        description={`At least one document, at most ${maxFiles}. Up to ${maxFileMb} MB each.`}
      >
        <Field
          label="Proof documents"
          htmlFor="files"
          required
          error={fieldErrors.files}
          hint="JPG, PNG, WebP or PDF. Files are checked against their real contents, not their names."
        >
          <input
            id="files"
            name="files"
            type="file"
            multiple
            accept={accept}
            className="block w-full text-[13px] text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-[13px] file:font-medium file:text-white hover:file:bg-slate-800"
          />
        </Field>
      </Card>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Submitting…' : 'Submit for approval'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * One of the two mapping directions, as a labelled card rather than a bare radio.
 *
 * The distinction being made is "which of these two books does the sale start
 * in", which a one-line radio label does not carry. Each option states the claim
 * in the rep's own words and then the situation it describes, so the choice is
 * legible without reference to the word "mapping" at all.
 */
function DirectionOption({
  value,
  checked,
  onSelect,
  title,
  detail,
}: {
  value: 'CLAIM_IN' | 'TRANSFER_OUT';
  checked: boolean;
  onSelect: (value: 'CLAIM_IN' | 'TRANSFER_OUT') => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3 ${
        checked ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:border-slate-300'
      }`}
    >
      <input
        type="radio"
        name="directionChoice"
        value={value}
        checked={checked}
        onChange={() => onSelect(value)}
        className="mt-0.5 size-4 shrink-0 accent-slate-900"
      />
      <span>
        <span className="block text-[13px] font-medium text-slate-900">{title}</span>
        <span className="block text-[12px] leading-snug text-slate-500">{detail}</span>
      </span>
    </label>
  );
}

function Pair({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="w-[112px] shrink-0 pt-px text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[13px] text-slate-900">{value ?? '—'}</dd>
    </div>
  );
}
