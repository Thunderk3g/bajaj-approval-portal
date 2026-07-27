'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CANONICAL_FIELDS } from '@/lib/fields';
import { setColumnMappingAction, validateBatchAction } from '@/lib/import/actions';
import type { ColumnMapping, MappingSuggestion, SourceColumn } from '@/lib/import/types';
import { Alert, Badge, Button, Select, Table, Td, Th } from '@/components/ui';

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
      <Table>
        <thead>
          <tr>
            <Th>Canonical field</Th>
            <Th>Source column</Th>
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
                  {reason && reason.columnKey === selected ? (
                    <span className="ml-1.5 align-middle">
                      <Badge tone="info">auto</Badge>
                    </span>
                  ) : null}
                  {errors?.map((message) => (
                    <p key={message} className="mt-1 text-xs text-red-700">
                      {message}
                    </p>
                  ))}
                </Td>
                <Td>
                  <Select
                    aria-label={`Source column for ${field.label}`}
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
                <Td className="font-mono text-xs text-slate-600">
                  {selected ? (samples[selected] ?? []).join(' · ') || '—' : '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>

      <Alert tone="info" title={`${unmapped.length} column${unmapped.length === 1 ? '' : 's'} left unmapped`}>
        These are preserved on every record rather than discarded, and stay searchable:{' '}
        <span className="font-mono text-xs">
          {unmapped.length === 0 ? 'none' : unmapped.map((c) => c.key).join(', ')}
        </span>
      </Alert>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save(true)} disabled={pending}>
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
