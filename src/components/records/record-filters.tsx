'use client';

/**
 * The one client component in the record slice.
 *
 * Everything else on these pages is a Server Component; this is 'use client'
 * only because a filter bar that needs a round-trip and a Submit press for each
 * of nine controls is unusable. Selects apply on change, the search box applies
 * on submit.
 *
 * It deliberately does not call `useSearchParams`: the server page has already
 * parsed and sanitised the URL, and it passes the result down as `values`. That
 * keeps one parser (`parseRecordFilters`) authoritative instead of having the
 * client re-derive state from a URL the server has already rejected parts of,
 * and it avoids dragging the page into a Suspense boundary.
 */

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Field, Input, Select, cx } from '@/components/ui';
import { GAP_LABELS, GAP_TYPES } from '@/lib/records/gaps';
import { CORRECTION_STATUSES, FILTER_KEYS } from '@/lib/records/filters';
import { PAGE_SIZES } from '@/lib/pagination';

export type FilterFormProps = {
  basePath: string;
  values: Record<string, string>;
  pageSize: number;
  showSmId: boolean;
  smIdOptions: Array<{ smId: string; smName: string | null }>;
  statusOptions: string[];
  batchOptions: Array<{ id: string; label: string }>;
};

export function RecordFilterBar({
  basePath,
  values,
  pageSize,
  showSmId,
  smIdOptions,
  statusOptions,
  batchOptions,
}: FilterFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<Record<string, string>>({
    ...values,
    pageSize: String(pageSize),
  });

  function apply(next: Record<string, string>) {
    const merged = { ...draft, ...next };
    setDraft(merged);

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value !== '') params.set(key, value);
    }
    // `page` is never carried across a filter change. Narrowing a 400-row list
    // to 12 while sitting on page 7 would otherwise render an empty grid that
    // looks exactly like "no matches".
    params.delete('page');

    const query = params.toString();
    startTransition(() => router.push(query ? `${basePath}?${query}` : basePath));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    apply({});
  }

  const isFiltered = FILTER_KEYS.some((key) => (draft[key] ?? '') !== '');

  return (
    <form
      onSubmit={onSubmit}
      className={cx(
        'rounded-lg border border-slate-200 bg-white p-4 transition-opacity',
        pending && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <Field label="Search" htmlFor="filter-q" hint="Application, policy, client, SM name, or any preserved column">
            <Input
              id="filter-q"
              name="q"
              type="search"
              placeholder="e.g. 6167509575 or Sharma"
              value={draft.q ?? ''}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
            />
          </Field>
        </div>
        <Button type="submit" disabled={pending}>
          Search
        </Button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Status" htmlFor="filter-status">
          <Select
            id="filter-status"
            value={draft.status ?? ''}
            onChange={(e) => apply({ status: e.target.value })}
          >
            <option value="">Any status</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Gap" htmlFor="filter-gap">
          <Select id="filter-gap" value={draft.gap ?? ''} onChange={(e) => apply({ gap: e.target.value })}>
            <option value="">Any</option>
            <option value="ANY">Has any gap</option>
            {GAP_TYPES.map((gap) => (
              <option key={gap} value={gap}>
                {GAP_LABELS[gap]}
              </option>
            ))}
          </Select>
        </Field>

        {showSmId ? (
          <Field label="SM ID" htmlFor="filter-sm">
            <Select id="filter-sm" value={draft.smId ?? ''} onChange={(e) => apply({ smId: e.target.value })}>
              <option value="">All reps</option>
              {smIdOptions.map((option) => (
                <option key={option.smId} value={option.smId}>
                  {option.smId}
                  {option.smName ? ` — ${option.smName}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}

        <Field label="Batch" htmlFor="filter-batch">
          <Select
            id="filter-batch"
            value={draft.batchId ?? ''}
            onChange={(e) => apply({ batchId: e.target.value })}
          >
            <option value="">Any batch</option>
            {batchOptions.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Issued from" htmlFor="filter-from">
          <Input
            id="filter-from"
            type="date"
            value={draft.issuedFrom ?? ''}
            onChange={(e) => apply({ issuedFrom: e.target.value })}
          />
        </Field>

        <Field label="Issued to" htmlFor="filter-to">
          <Input
            id="filter-to"
            type="date"
            value={draft.issuedTo ?? ''}
            onChange={(e) => apply({ issuedTo: e.target.value })}
          />
        </Field>

        <Field label="Corrections" htmlFor="filter-has-corrections">
          <Select
            id="filter-has-corrections"
            value={draft.hasCorrections ?? ''}
            onChange={(e) => apply({ hasCorrections: e.target.value })}
          >
            <option value="">Any</option>
            <option value="true">Has corrections</option>
            <option value="false">No corrections</option>
          </Select>
        </Field>

        <Field label="Correction status" htmlFor="filter-correction-status">
          <Select
            id="filter-correction-status"
            value={draft.correctionStatus ?? ''}
            onChange={(e) => apply({ correctionStatus: e.target.value })}
          >
            <option value="">Any</option>
            {CORRECTION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Per page" htmlFor="filter-page-size">
          <Select
            id="filter-page-size"
            value={draft.pageSize}
            onChange={(e) => apply({ pageSize: e.target.value })}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {isFiltered ? (
        <div className="mt-3">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              const cleared: Record<string, string> = {};
              for (const key of FILTER_KEYS) cleared[key] = '';
              apply(cleared);
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : null}
    </form>
  );
}
