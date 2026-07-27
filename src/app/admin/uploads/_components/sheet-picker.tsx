'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setBatchSheetAction } from '@/lib/import/actions';
import { DATE_FORMATS, type DateFormat } from '@/lib/import/dates';
import type { SheetInfo } from '@/lib/import/types';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

export function SheetPicker({
  batchId,
  sheets,
  sheetName,
  headerRow,
  dateFormat,
}: {
  batchId: string;
  sheets: SheetInfo[];
  sheetName: string;
  headerRow: number;
  dateFormat: DateFormat;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [values, setValues] = useState({ sheetName, headerRow: String(headerRow), dateFormat });

  function submit() {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await setBatchSheetAction({
        batchId,
        sheetName: values.sheetName,
        headerRow: Number(values.headerRow),
        dateFormat: values.dateFormat,
      });
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Sheet" htmlFor="sheetName" required error={fieldErrors.sheetName}>
          <Select
            id="sheetName"
            value={values.sheetName}
            disabled={pending}
            onChange={(e) => setValues((v) => ({ ...v, sheetName: e.target.value }))}
          >
            {sheets.map((sheet) => (
              <option key={sheet.name} value={sheet.name}>
                {sheet.name} — {sheet.rowCount.toLocaleString('en-IN')} rows ×{' '}
                {sheet.columnCount.toLocaleString('en-IN')} cols
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Header row"
          htmlFor="headerRow"
          required
          error={fieldErrors.headerRow}
          hint="Not always 1: some sheets carry totals above the headers."
        >
          <Input
            id="headerRow"
            type="number"
            min={1}
            value={values.headerRow}
            disabled={pending}
            onChange={(e) => setValues((v) => ({ ...v, headerRow: e.target.value }))}
          />
        </Field>

        <Field
          label="Date format"
          htmlFor="dateFormat"
          required
          error={fieldErrors.dateFormat}
          hint="Used only for text dates. 03/04/2026 is 3 April or 4 March — this decides which."
        >
          <Select
            id="dateFormat"
            value={values.dateFormat}
            disabled={pending}
            onChange={(e) => setValues((v) => ({ ...v, dateFormat: e.target.value as DateFormat }))}
          >
            {DATE_FORMATS.map((format) => (
              <option key={format} value={format}>
                {format}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex items-center gap-3">
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? 'Reading sheet…' : 'Use this sheet'}
        </Button>
        <p className="text-xs text-slate-500">
          Changing the sheet clears any column mapping made against the previous one.
        </p>
      </div>
    </div>
  );
}
