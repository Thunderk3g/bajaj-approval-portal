'use client';

import { useEffect } from 'react';
import { Alert, Button, LinkButton } from '@/components/ui';

/**
 * The last thing between a failed render and Next's crash screen.
 *
 * Every route in this portal is force-dynamic and queries Postgres before it
 * renders, so a dropped connection or a bad migration is a render-time throw on
 * an ordinary page — and without this the user gets the framework's stack trace
 * with no way back.
 *
 * The message is NOT shown. A Postgres error carries the failing statement, and
 * these statements select client names, application numbers and premium
 * figures; a driver error is as likely to leak a row as to name a table. It goes
 * to the console — server-side for a Server Component throw, browser console for
 * a client one — where an operator can read it and a screenshot cannot.
 *
 * `digest` is the exception: it is a hash Next also writes to the server log,
 * carries nothing of the error itself, and is the only thing that lets someone
 * reporting this be matched to the log line that explains it.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[portal] unhandled render error', error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight text-slate-900">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          This screen could not be loaded. Nothing you were doing has been changed — a page that
          fails to load has not written anything. Try again, and if it keeps happening tell your
          portal administrator.
        </p>

        {error.digest ? (
          <div className="mt-4">
            <Alert tone="info" title="Reference for your administrator">
              <span className="font-mono text-[12px]">{error.digest}</span>
            </Alert>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button type="button" onClick={reset}>
            Try again
          </Button>
          <LinkButton href="/">Back to my dashboard</LinkButton>
        </div>
      </div>
    </main>
  );
}
