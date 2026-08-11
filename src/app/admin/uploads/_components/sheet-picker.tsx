'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setBatchSheetAction } from '@/lib/import/actions';
import { DATE_FORMATS, type DateFormat } from '@/lib/import/dates';
import { isTransactionSheet, sheetExclusionReason } from '@/lib/import/sheets';
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

/*
 * The predicate is shared with the server, not restated here.
 *
 * This file used to carry its own, excluding `Lead Dump` and nothing else, while
 * `suggestSheet` excluded four presentation tabs and nothing else. Neither
 * excluded `Manpower`, so it was offered — and choosing it repointed the batch
 * at a seven-column roster sheet that was then scored against `CANONICAL_FIELDS`,
 * producing a column-mapping error for a sheet nobody maps by hand.
 */

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
  const skipped = sheets.filter((s) => !isTransactionSheet(s));
  const excluded = skipped.length;

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
            className="font-mono"
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

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? 'Queueing…' : 'Use this sheet'}
        </Button>
        <p className="text-[12px] leading-relaxed text-slate-500">
          Changing the sheet clears any column mapping made against the previous one and re-reads
          the workbook.
        </p>
      </div>

      {/*
        Names every sheet that was withheld and why. The count alone read as
        "some sheets are missing" and sent the admin looking for the one they
        expected — usually Manpower, which has its own step above.

        Its own block, below the action row: inside it — which is where this
        used to sit — a flex child of a centred row squeezed a list of six sheet
        names into whatever width the button and its caption left over.
      */}
      {excluded > 0 ? (
        <details className="text-[11px] text-slate-500">
          <summary className="cursor-pointer select-none hover:text-slate-700">
            {excluded} sheet{excluded === 1 ? '' : 's'} not offered here
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-4">
            {skipped.map((name) => (
              <li key={name}>
                <span className="font-mono">{name}</span> — {sheetExclusionReason(name)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
