'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { importLeadsAction } from '@/lib/import/actions';
import { Alert, Button } from '@/components/ui';

/**
 * Starts the `Lead Dump` import for an upload.
 *
 * Deliberately a button rather than something the upload does on its own. The
 * sheet is 54,507 rows and its import is a separate decision from the
 * transaction commit — leads are a read-only view scoped by SM code, so an admin
 * may want them in front of reps while the transaction rows are still being
 * reviewed, or may not want them at all from a file uploaded to fix one column.
 *
 * The progress bar is `ParseProgress`, unchanged: both are `ingest_job` rows and
 * the service writes its own stage text ("streaming Lead Dump"), so a second
 * component would be a second place to phrase the same states.
 */
export function ImportLeadsButton({ batchId, label }: { batchId: string; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setPending(true);
    setError(null);

    const result = await importLeadsAction({ batchId });

    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    // Refreshed rather than tracked here: the server renders the progress bar
    // from the job row it now finds, so this component never holds a job id.
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <Button type="button" onClick={() => void run()} disabled={pending}>
        {pending ? 'Starting…' : label}
      </Button>
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </div>
  );
}
