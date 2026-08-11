'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CANONICAL_FIELDS } from '@/lib/fields';
import { setColumnMappingAction, validateBatchAction } from '@/lib/import/actions';
import type { ColumnMapping, MappingSuggestion, SourceColumn } from '@/lib/import/types';
import type { MatchReason } from '@/lib/import/types';
import { Alert, Badge, Button, Select, Spinner, Table, Td, Th } from '@/components/ui';

/**
 * Why the scorer picked a column, in words.
 *
 * The reason was already computed and passed to this screen; until now it only
 * lit an "auto" badge, which says a machine chose without saying on what
 * evidence. An alias hit is near-certain and a substring hit is a guess — and
 * that difference is exactly what decides whether the admin reads the sample
 * values before moving on.
 */
const REASON_LABELS: Record<MatchReason, string> = {
  ALIAS: 'header is a known alias of this field',
  LABEL: 'header matches the field name',
  PREFIX: 'header starts with the field name',
  CONTAINS: 'field name appears inside the header',
};

/**
 * The human gate of spec section 6: the admin confirms the mapping, sees real
 * parsed sample values from the actual file, and only then validates.
 *
 * Every suggestion is overridable and any field may be left unmapped. A source
 * column with no canonical home is not discarded — it lands in
 * `sales_record.extra` and stays searchable.
 */
export function MappingForm({
  batchId,
  columns,
  samples,
  suggestion,
  current,
}: {
  batchId: string;
  columns: SourceColumn[];
  /** Column key -> the first few parsed values, exactly as read from the file. */
  samples: Record<string, string[]>;
  suggestion: MappingSuggestion;
  current: ColumnMapping | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [mapping, setMapping] = useState<ColumnMapping>(current ?? suggestion.mapping);

  const usedColumns = new Set(Object.values(mapping).filter(Boolean));
  const unmapped = columns.filter((c) => !usedColumns.has(c.key));

  // The one gate on this screen, said before the table rather than discovered by
  // pressing Confirm and reading errors scattered down twenty rows.
  const required = CANONICAL_FIELDS.filter((field) => field.required);
  const missing = required.filter((field) => !mapping[field.key]);

  function save(thenValidate: boolean) {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const saved = await setColumnMappingAction({ batchId, mapping });
      if (!saved.ok) {
        setError(saved.error);
        setFieldErrors(saved.fieldErrors ?? {});
        return;
      }
      if (thenValidate) {
        const validated = await validateBatchAction({ batchId });
        if (!validated.ok) {
          setError(validated.error);
          return;
        }
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <p
        className={
          missing.length > 0
            ? 'text-[12px] font-medium text-amber-800'
            : 'text-[12px] font-medium text-emerald-800'
        }
      >
        {missing.length === 0 ? (
          <>All {required.length} required fields are mapped.</>
        ) : (
          <>
            {required.length - missing.length} of {required.length} required fields mapped — still
            needed: {missing.map((field) => field.label).join(', ')}.
          </>
        )}
      </p>

      <Table>
        <thead>
          <tr>
            <Th>Canonical field</Th>
            <Th>Source column</Th>
            <Th>Why</Th>
            <Th>Sample values from this file</Th>
          </tr>
        </thead>
        <tbody>
          {CANONICAL_FIELDS.map((field) => {
            const selected = mapping[field.key] ?? '';
            const reason = suggestion.reasons[field.key];
            const errors = fieldErrors[field.key];

            return (
              <tr key={field.key}>
                <Td>
                  <span className="font-medium text-slate-900">{field.label}</span>
                  {field.required ? (
                    <span className="ml-1.5 align-middle">
                      <Badge tone="danger">required</Badge>
                    </span>
                  ) : null}
                  {errors?.map((message) => (
                    <p key={message} className="mt-1 text-xs text-red-700">
                      {message}
                    </p>
                  ))}
                </Td>
                <Td>
                  {/* Monospaced: these are the workbook's own header strings,
                      compared against each other down the column. */}
                  <Select
                    aria-label={`Source column for ${field.label}`}
                    className="font-mono text-[12px]"
                    value={selected}
                    disabled={pending}
                    onChange={(e) =>
                      setMapping((m) => {
                        const next = { ...m };
                        if (e.target.value === '') delete next[field.key];
                        else next[field.key] = e.target.value;
                        return next;
                      })
                    }
                  >
                    <option value="">— not mapped —</option>
                    {columns.map((column) => (
                      <option key={column.key} value={column.key}>
                        {column.key}
                        {column.blank ? ' (no header)' : ''}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td className="text-[12px] text-slate-500">
                  {!selected ? (
                    '—'
                  ) : reason && reason.columnKey === selected ? (
                    <>
                      <Badge tone="info">auto</Badge>{' '}
                      <span className="align-middle">{REASON_LABELS[reason.reason]}</span>
                    </>
                  ) : (
                    // Said out loud, because an override that silently looks like
                    // a suggestion is how a wrong column survives this screen.
                    'chosen by hand'
                  )}
                </Td>
                <Td className="font-mono text-[12px] text-slate-600">
                  {selected ? (samples[selected] ?? []).join(' · ') || '—' : '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      {/*
        Folded, and no longer an Alert. Unmapped columns are the normal case —
        every workbook has some — and a permanent blue banner saying so trained
        the eye to skip the one place on this screen where a real problem is
        announced.
      */}
      <details className="text-[12px] text-slate-500">
        <summary className="cursor-pointer select-none hover:text-slate-700">
          {unmapped.length} column{unmapped.length === 1 ? '' : 's'} left unmapped — kept on every
          record and searchable, not discarded
        </summary>
        <p className="mt-1.5 pl-4 font-mono text-[11px] break-words">
          {unmapped.length === 0 ? 'none' : unmapped.map((c) => c.key).join(', ')}
        </p>
      </details>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save(true)} disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? 'Parsing and validating…' : 'Confirm mapping and validate'}
        </Button>
        <Button type="button" variant="secondary" onClick={() => save(false)} disabled={pending}>
          Save mapping only
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={pending}
          onClick={() => setMapping(suggestion.mapping)}
        >
          Reset to suggestions
        </Button>
      </div>
    </div>
  );
}
