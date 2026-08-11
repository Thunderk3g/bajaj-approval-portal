'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { generateExportAction } from '@/lib/export/actions';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import type { GeneratedExport } from '@/lib/export/service';

/**
 * The filter form — spec section 8.
 *
 * Client-side only for the pending state and error rendering. Nothing here is
 * a control: the same values are re-validated by the Zod schema on the server,
 * and the action re-checks the role.
 */

type BatchOption = { id: string; name: string; committedAt: Date | null };

// Filtered by code, not id: the chosen value is stored on the export row and
// read back months later, where "2026-07" still says which month it was and a
// uuid does not.
type PeriodOption = { code: string; label: string; status: string };

function SubmitButton() {
  // Building a workbook over a full book takes seconds; without this the admin
  // clicks again and generates a second identical export.
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Generating…' : 'Generate export'}
    </Button>
  );
}

export function ExportForm({
  batches,
  periods,
}: {
  batches: BatchOption[];
  periods: PeriodOption[];
}) {
  const [state, formAction] = useActionState<ActionResult<GeneratedExport> | null, FormData>(
    generateExportAction,
    null,
  );

  const fieldErrors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <Card title="New export" description="Leave a filter blank to include everything.">
      <form action={formAction} className="space-y-4">
        {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        {state?.ok ? (
          <Alert tone="success" title={state.data.fileName}>
            {state.data.rowCount} record{state.data.rowCount === 1 ? '' : 's'} and{' '}
            {state.data.correctionCount} applied correction
            {state.data.correctionCount === 1 ? '' : 's'} written. It is listed below.
          </Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Batch" htmlFor="batchId" error={fieldErrors.batchId}>
            <Select id="batchId" name="batchId" defaultValue="">
              <option value="">All committed batches</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.name}
                  {batch.committedAt
                    ? ` — ${new Date(batch.committedAt).toISOString().slice(0, 10)}`
                    : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Period"
            htmlFor="periodCode"
            hint="The month a record was last imported in. Independent of the issuance dates below."
            error={fieldErrors.periodCode}
          >
            <Select id="periodCode" name="periodCode" defaultValue="">
              <option value="">All months</option>
              {periods.map((period) => (
                <option key={period.code} value={period.code}>
                  {period.label}
                  {period.status === 'CLOSED' ? ' — closed' : ''}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="SM ID"
            htmlFor="smId"
            hint="Matched exactly, uppercased before the query runs."
            error={fieldErrors.smId}
          >
            <Input id="smId" name="smId" placeholder="C2CM21350" autoComplete="off" />
          </Field>

          <Field label="Issued from" htmlFor="issuedFrom" error={fieldErrors.issuedFrom}>
            <Input id="issuedFrom" name="issuedFrom" type="date" />
          </Field>

          <Field
            label="Issued to"
            htmlFor="issuedTo"
            hint="A date range excludes records with no issuance date."
            error={fieldErrors.issuedTo}
          >
            <Input id="issuedTo" name="issuedTo" type="date" />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="correctedOnly"
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          Corrected records only
        </label>

        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              name="sourceLayout"
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
            />
            Match the uploaded sheet
          </label>
          <p className="text-xs text-slate-500">
            Same columns, same order, nothing added — corrected cells are highlighted. Needs a
            batch, since the layout belongs to one file.
          </p>
          {fieldErrors.sourceLayout
            ? [fieldErrors.sourceLayout].flat().map((message) => (
                <p key={message} className="text-xs text-red-700">
                  {message}
                </p>
              ))
            : null}
        </div>

        <SubmitButton />
      </form>
    </Card>
  );
}
