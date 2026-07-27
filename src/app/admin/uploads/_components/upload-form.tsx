'use client';

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createUploadBatchAction } from '@/lib/import/actions';
import { Alert, Button, Field, Input, Textarea } from '@/components/ui';

/**
 * The upload step. Client-side only because a file input needs an onChange and
 * the result carries a warning the admin has to read before continuing.
 */
export function UploadForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    const formData = new FormData(event.currentTarget);
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await createUploadBatchAction(formData);

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      // The identical-hash warning travels on the query string rather than in
      // component state: the next screen is a server render and the admin must
      // still see it after a refresh.
      const suffix = result.data.duplicateOfBatchId ? '?reupload=1' : '';
      router.push(`/admin/uploads/${result.data.batchId}${suffix}`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field
        label="Workbook"
        htmlFor="file"
        required
        error={fieldErrors.file}
        hint="Accepted formats: .xlsb, .xlsx, .xlsm, .xls. The file is stored unchanged and is never written to."
      >
        <Input
          id="file"
          name="file"
          type="file"
          accept=".xlsb,.xlsx,.xlsm,.xls"
          required
          disabled={pending}
        />
      </Field>

      <Field label="Notes" htmlFor="notes" hint="Optional. Shown on the batch list.">
        <Textarea id="notes" name="notes" disabled={pending} placeholder="e.g. June dashboard extract" />
      </Field>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Button type="submit" disabled={pending}>
        {pending ? 'Uploading…' : 'Upload and continue'}
      </Button>
    </form>
  );
}
