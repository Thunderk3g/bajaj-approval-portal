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
  const [appsNo, setAppsNo] = useState(initialAppsNo);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

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

          <Field
            label="Application number"
            htmlFor="appsNo"
            required
            error={fieldErrors.appsNo}
            hint={
              category === 'MAPPING'
                ? 'Look the application up to confirm it is the sale you mean before you claim it.'
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
              {category === 'MAPPING' ? (
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

          {category === 'MAPPING' && (lookup || lookupMessage) ? (
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
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
                <p className="mt-2 text-xs text-slate-500">{lookupMessage}</p>
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
            label={category === 'MAPPING' ? 'Move the sale to' : 'Corrected value'}
            htmlFor="proposedValue"
            required
            error={fieldErrors.proposedValue}
            hint={
              category === 'MAPPING'
                ? 'A mapping claim always moves the sale to you. The SM name is resolved from the Manpower roster when it is approved.'
                : undefined
            }
          >
            {category === 'AUTOPAY' ? (
              <Select id="proposedValue" name="proposedValue" defaultValue="Yes">
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </Select>
            ) : category === 'MAPPING' ? (
              // Read-only, and the server ignores it anyway: the claimant's
              // SM_ID is taken from the session so a claim cannot be used to
              // push a sale onto a third party (section 7.2).
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
            className="block w-full text-sm text-slate-700 file:mr-3 file:rounded file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800"
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

function Pair({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-900">{value ?? '—'}</dd>
    </div>
  );
}
