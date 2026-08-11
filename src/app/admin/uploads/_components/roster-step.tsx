'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { commitRosterAction } from '@/lib/import/actions';
import { Alert, Button, DetailRow } from '@/components/ui';

/**
 * Commit this workbook's Manpower sheet to the roster.
 *
 * A step of its own, before the column mapping and the policy commit, because
 * the reporting line it writes is what the policies are then mapped AGAINST.
 * Folding it into the policy commit — which is what used to happen — meant the
 * hierarchy every approval routes through was written as a side effect, from a
 * sheet nobody had opened.
 *
 * Body only: the card, the step number and the committed/not-committed badge are
 * the page's, because they have to agree with the five other steps and with the
 * rail at the top. This component used to title itself "Step 1", which is how
 * the page ended up with a step 1 below an unnumbered card and above a step 2.
 *
 * Re-runnable on purpose. Importing a corrected sheet updates placements in
 * place; the button says so rather than looking like a one-shot action somebody
 * is afraid to press twice.
 */
export function RosterStep({
  batchId,
  committedAt,
  hasManpowerSheet,
  sheetName,
}: {
  batchId: string;
  committedAt: Date | null;
  hasManpowerSheet: boolean;
  sheetName: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ upserted: number; unplaced: number } | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await commitRosterAction({ batchId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone({ upserted: result.data.upserted, unplaced: result.data.unplaced });
      router.refresh();
    });
  }

  const committed = Boolean(committedAt);

  return (
    <div className="space-y-3">
      {!hasManpowerSheet ? (
        <Alert tone="danger" title="This workbook has no Manpower sheet">
          The roster can only come from a <span className="font-mono">Manpower</span> sheet. Upload a
          workbook that carries one — the policies in this file cannot be committed until a roster
          exists.
        </Alert>
      ) : (
        <dl>
          <DetailRow label="Sheet">
            <span className="font-mono">{sheetName}</span>
          </DetailRow>
          <DetailRow label="Committed">
            {committedAt ? (
              committedAt.toISOString().slice(0, 16).replace('T', ' ')
            ) : (
              <span className="text-slate-400">not yet</span>
            )}
          </DetailRow>
        </dl>
      )}

      {done ? (
        <Alert tone={done.unplaced > 0 ? 'warning' : 'success'}>
          {done.upserted} rep{done.upserted === 1 ? '' : 's'} placed.
          {done.unplaced > 0 ? (
            <>
              {' '}
              {done.unplaced} of them name no team leader, so their mapping corrections will skip
              both manager steps. Fix on <span className="font-medium">Hierarchy</span>.
            </>
          ) : null}
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {hasManpowerSheet ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={run} disabled={pending}>
            {pending
              ? 'Committing…'
              : committed
                ? 'Re-commit the roster from this sheet'
                : 'Commit the roster'}
          </Button>
          <span className="text-[12px] text-slate-500">
            {committed
              ? 'Re-running updates placements in place. Admin overrides survive it.'
              : 'Every step after this one is matched against the hierarchy this writes.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}
