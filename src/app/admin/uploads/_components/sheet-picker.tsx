'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setBatchSheetAction } from '@/lib/import/actions';
import { DATE_FORMATS, type DateFormat } from '@/lib/import/dates';
import { Alert, Button, Field, Input, Select } from '@/components/ui';

/**
 * Names only, no row or column counts.
 *
 * The ingestion service refuses to report them and it is right to: the only
 * number available without reading a sheet is its DECLARED range, and `Lead
 * Dump` declares 54,508 x 16,383 because one row carries formatting out to
 * column 16,383. Showing a declared range as a row count is how a 9 MB file gets
 * described as 893 million cells on the screen the admin uses to choose.
 */

/**
 * The one sheet this picker must not offer.
 *
 * It is not a transaction sheet — it carries leads, has no `Apps_No`, and has
 * its own import on the card below this one. Offering it here was a real
 * failure, not a tidiness problem: choosing it queued a parse that the service
 * refuses outright, because reading it through the sheet reader materialises a
 * 54,508 x 16,383 declared range and asks for roughly 28 GB. The admin got a
 * FAILED job quoting that number and no way to tell that the sheet was simply
 * the wrong choice.
 *
 * Matched case-insensitively against the trimmed name, the same comparison
 * `resolve_sheet` makes in the service — which already skipped this sheet when
 * choosing one automatically. Only the explicit choice was unguarded.
 */
const LEAD_SHEET = 'lead dump';

export function isTransactionSheet(name: string): boolean {
  return name.trim().toLowerCase() !== LEAD_SHEET;
}

export function SheetPicker({
  batchId,
  sheets,
  sheetName,
  headerRow,
  dateFormat,
}: {
  batchId: string;
  sheets: string[];
  sheetName: string;
  headerRow: number;
  dateFormat: DateFormat;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [values, setValues] = useState({ sheetName, headerRow: String(headerRow), dateFormat });

  const selectable = sheets.filter(isTransactionSheet);
  const excluded = sheets.length - selectable.length;

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
            {selectable.map((name) => (
              <option key={name} value={name}>
                {name}
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
          {pending ? 'Queueing…' : 'Use this sheet'}
        </Button>
        <p className="text-xs text-slate-500">
          Changing the sheet clears any column mapping made against the previous one and re-reads
          the workbook.
          {excluded > 0
            ? ' Lead Dump is not listed: it carries leads rather than transactions and is imported separately below.'
            : null}
        </p>
      </div>
    </div>
  );
}
