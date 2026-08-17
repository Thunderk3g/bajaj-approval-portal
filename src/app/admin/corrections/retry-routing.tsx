'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { retryStageRoutingAction } from '@/lib/workflows/actions';
import { Alert, buttonClass } from '@/components/ui';

/**
 * "Look again" for a rung that resolved to nobody.
 *
 * The two ways such a rung gets fixed are asymmetric, and this button exists for
 * the second one. If the chain itself named nobody, editing the chain re-routes
 * everything stranded behind it automatically. But if the chain named a real
 * manager who simply had no portal account, the fix is on the People screen — no
 * chain changes, so nothing tells the stranded request to try again.
 *
 * Reports the refusal rather than swallowing it: "still cannot be routed, because
 * the roster does not record a TL for ICCSP90766" is the sentence that sends the
 * admin to the right screen. A silent no-op would just look broken.
 */
export function RetryRouting({ requestId }: { requestId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  function retry() {
    setResult(null);
    startTransition(async () => {
      const outcome = await retryStageRoutingAction({ requestId });

      if (!outcome.ok) {
        setResult({ tone: 'warning', text: outcome.error });
        return;
      }

      if (outcome.data.routed) {
        setResult({
          tone: 'success',
          text: `Step "${outcome.data.stageKey}" is routed and the person it belongs to has been notified.`,
        });
        router.refresh();
        return;
      }

      setResult({
        tone: 'warning',
        text: `Still nobody to route "${outcome.data.stageKey}" to — ${outcome.data.reason ?? 'the resolver returned nothing.'}`,
      });
    });
  }

  return (
    <>
      <button type="button" className={buttonClass('secondary')} onClick={retry} disabled={pending}>
        {pending ? 'Looking…' : 'Retry routing'}
      </button>
      {result ? (
        <div className="mt-2 w-full">
          <Alert tone={result.tone}>{result.text}</Alert>
        </div>
      ) : null}
    </>
  );
}
