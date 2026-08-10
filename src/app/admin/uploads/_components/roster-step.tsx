'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { commitRosterAction } from '@/lib/import/actions';
import { Alert, Badge, Button, Card, DetailRow } from '@/components/ui';

/**
 * Step one of an import: commit this workbook's Manpower sheet to the roster.
 *
 * A step of its own, before the column mapping and the policy commit, because
 * the reporting line it writes is what the policies are then mapped AGAINST.
 * Folding it into the policy commit — which is what used to happen — meant the
 * hierarchy every approval routes through was written as a side effect, from a
 * sheet nobody had opened.
 *
 * Re-runnable on purpose. Importing a corrected sheet updates placements in
 * place; the button says so rather than looking like a one-shot action somebody
 * is afraid to press twice.
 */
export function RosterStep({
  batchId,
  committedAt,
  rowCount,
  hasManpowerSheet,
  sheetName,
}: {
  batchId: string;
  committedAt: Date | null;
  rowCount: number;
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
    <Card
      title="Step 1 — the reporting line"
      description="Who reports to whom. Committed on its own, before any policy is mapped against it."
      actions={
        committed ? (
          <Badge tone="success">Committed · {rowCount} reps</Badge>
        ) : (
          <Badge tone="warning">Not committed</Badge>
        )
      }
    >
      <div className="space-y-3">
        {!hasManpowerSheet ? (
          <Alert tone="danger" title="This workbook has no Manpower sheet">
            The roster can only come from a <span className="font-mono">Manpower</span> sheet. Upload
            a workbook that carries one — the policies in this file cannot be committed until a
            roster exists.
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
            {committed ? (
              <span className="text-[12px] text-slate-500">
                Re-running updates placements in place. Admin overrides survive it.
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
