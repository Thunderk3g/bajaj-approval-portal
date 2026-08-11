'use client';

import { useRef, useState, useTransition, type DragEvent, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createUploadBatchAction } from '@/lib/import/actions';
import {
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_MB,
  formatBytes,
  rejectUpload,
} from '@/lib/import/upload-limits';
import { Alert, Button, Field, Spinner, Textarea, cx } from '@/components/ui';

/**
 * The upload step.
 *
 * The plain `<input type="file">` this replaces was the least streamlined
 * control in the portal: a browser-default button reading "No file chosen", no
 * confirmation of what was picked, and — because the whole workbook is posted
 * through a Server Action — up to a minute of nothing before the server got
 * round to saying the extension was never readable.
 *
 * So: the file is named and sized on screen the moment it is chosen, the two
 * rules the server enforces are applied here first, and the drop target is the
 * card itself rather than a 200px-wide button.
 *
 * The input is still a real, required `<input type="file" name="file">` inside a
 * real form — dropping writes to its `.files` via DataTransfer instead of
 * keeping a second copy of the file in React state. One source of truth for what
 * gets posted, and the form still works with the keyboard alone.
 */
export function UploadForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  /** Accepts a picked or dropped file, or explains why it cannot. */
  function take(next: File | null) {
    setError(null);
    setFieldErrors({});

    if (!next) {
      setFile(null);
      return;
    }

    const reason = rejectUpload(next);
    if (reason) {
      // Cleared as well as reported: leaving a refused file in the input is how
      // "Upload" gets pressed again on the same file that was just turned down.
      if (inputRef.current) inputRef.current.value = '';
      setFile(null);
      setFieldErrors({ file: [reason] });
      return;
    }

    setFile(next);
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    if (pending) return;

    const dropped = event.dataTransfer.files;
    if (dropped.length === 0) return;
    if (dropped.length > 1) {
      setFieldErrors({ file: ['One workbook at a time.'] });
      return;
    }

    // Assigning the FileList to the input is what keeps the dropped file and the
    // posted file the same object. Guarded because a browser that refuses the
    // assignment must fall back to the picker rather than silently posting
    // nothing.
    if (inputRef.current) {
      inputRef.current.files = dropped;
      take(inputRef.current.files?.[0] ?? null);
    }
  }

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

  const fileErrors = fieldErrors.file ?? [];

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1.5">
        <label htmlFor="file" className="block text-[13px] font-medium text-slate-700">
          Workbook
          <span className="ml-0.5 text-red-700" aria-hidden="true">
            *
          </span>
        </label>

        {/*
          The input comes first so the drop zone can be its `peer` — the control
          is visually hidden but still in the tab order, and without the peer
          rule a keyboard user tabbing onto it would see nothing move.
        */}
        <input
          ref={inputRef}
          id="file"
          name="file"
          type="file"
          accept={ALLOWED_EXTENSIONS.join(',')}
          required
          disabled={pending}
          onChange={(event) => take(event.currentTarget.files?.[0] ?? null)}
          // Off-screen rather than `hidden`: a display:none input is skipped by
          // the tab order and by native "please fill in this field" validation,
          // which is the whole reason the required attribute is here.
          className="peer sr-only"
        />

        {/*
          A second label for the same input — valid, and the accessible name it
          builds ("Workbook, drop a workbook here…, .xlsb · .xlsx …") is a better
          description of the control than either half alone. Being a label is
          also what makes the whole zone the input's own click target instead of
          a second tab stop that does the same thing.
        */}
        <label
          htmlFor="file"
          onDragOver={(event) => {
            event.preventDefault();
            if (!pending) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            'flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-7 text-center transition-colors',
            'peer-focus-visible:border-slate-500 peer-focus-visible:ring-2 peer-focus-visible:ring-slate-400 peer-focus-visible:ring-offset-1',
            pending
              ? 'cursor-not-allowed border-slate-200 bg-slate-50'
              : dragging
                ? 'border-slate-900 bg-slate-100'
                : fileErrors.length > 0
                  ? 'border-red-300 bg-red-50/60 hover:bg-red-50'
                  : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100',
          )}
        >
          {/*
            `pointer-events-none`, and it is load-bearing: dragging across the
            icon fires dragleave on the label as the pointer crosses into a
            child, so without this the zone flickers between states the whole
            time a file is held over it.
          */}
          <span className="pointer-events-none flex flex-col items-center">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-6 text-slate-400"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
              <path d="M3.5 15v3a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3" />
            </svg>

            <span className="mt-2 text-[13px] font-medium text-slate-700">
              {dragging ? 'Drop the workbook' : 'Drop a workbook here, or choose one'}
            </span>
            <span className="mt-0.5 text-[11px] text-slate-500">
              {ALLOWED_EXTENSIONS.join(' · ')} — up to {MAX_UPLOAD_MB} MB
            </span>
          </span>
        </label>

        {/*
          The chosen file, stated. A file input that shows only its own truncated
          name is how last month's extract gets imported as this month's — and
          the size is what tells the admin whether the upload about to start is a
          two-second one or a minute of a progress-less button.
        */}
        {file ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-slate-200 bg-white px-2.5 py-2">
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-slate-900">
              {file.name}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
              {formatBytes(file.size)}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (inputRef.current) inputRef.current.value = '';
                take(null);
              }}
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        ) : null}

        <p className="text-[11px] text-slate-500">
          The file is stored unchanged and is never written to. Uploading only stores and hashes it —
          nothing reaches the master records until you commit at step 6.
        </p>

        {fileErrors.map((message) => (
          <p key={message} className="text-[12px] text-red-700">
            {message}
          </p>
        ))}
      </div>

      <Field label="Notes" htmlFor="notes" hint="Optional. Shown on the batch list.">
        <Textarea
          id="notes"
          name="notes"
          disabled={pending}
          placeholder="e.g. June dashboard extract"
        />
      </Field>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !file}>
          {pending ? <Spinner /> : null}
          {pending ? 'Uploading…' : 'Upload and continue'}
        </Button>

        {/* A large .xlsb posts through a Server Action with no progress event to
            read, so the honest thing is to say how long it may sit there rather
            than animate a bar that knows nothing. */}
        <p aria-live="polite" className="text-[12px] text-slate-500">
          {pending
            ? `Sending ${file ? formatBytes(file.size) : 'the workbook'} — a large workbook can take a minute.`
            : file
              ? 'Reading starts automatically on the next screen.'
              : 'Choose a workbook to continue.'}
        </p>
      </div>
    </form>
  );
}
