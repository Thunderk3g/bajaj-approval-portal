'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { setChainActiveAction } from '@/lib/workflows/actions';
import type { ChainKey } from '@/lib/workflows/chains';
import { Alert, buttonClass } from '@/components/ui';

/**
 * Switches a chain off, so nothing new is raised onto it.
 *
 * The action behind this has existed and been documented since the engine
 * landed — "why the screen says so" — and no screen ever said so: it was an
 * exported Server Action with no caller, which is a POST endpoint nobody can
 * reach and a feature nobody can use. Wired up rather than deleted because the
 * gap it fills is the one that caused the trouble here: a chain whose steps
 * resolve to nobody strands every request raised onto it, and until now an
 * administrator who spotted that had no way to stop more arriving while they
 * fixed it.
 *
 * Switching off touches nothing already in flight — those carry their own copy
 * of the steps — so it is a safe stop-gap rather than an intervention.
 */
export function ChainToggle({ chainKey, isActive }: { chainKey: ChainKey; isActive: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await setChainActiveAction({ chainKey, isActive: !isActive });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className={buttonClass('secondary')} onClick={toggle} disabled={pending}>
        {pending ? 'Saving…' : isActive ? 'Switch off' : 'Switch on'}
      </button>
      {error ? (
        <div className="mt-2">
          <Alert tone="danger">{error}</Alert>
        </div>
      ) : null}
    </>
  );
}
