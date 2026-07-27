import { Badge, Card, EmptyState } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { versionChain, type RecordVersion } from '@/lib/records/versions';

const CHANGE_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning'> = {
  IMPORT: 'neutral',
  CORRECTION: 'success',
  REIMPORT: 'info',
  ADMIN_EDIT: 'warning',
};

/**
 * The full version chain with a per-version diff.
 *
 * Each entry is diffed against the version below it, which is why the chain is
 * rendered newest-first: the reader follows a record backwards from its current
 * state to the imported original, and the original value is the thing an
 * approver most often needs to see.
 */
export function VersionHistory({ versions }: { versions: RecordVersion[] }) {
  if (versions.length === 0) {
    return (
      <EmptyState
        title="No version history"
        description="Version 1 is written when the record is imported, so an empty chain means this record predates the import that would have created it."
      />
    );
  }

  const chain = versionChain(versions);

  return (
    <div className="space-y-3">
      {chain.map((entry) => (
        <Card
          key={entry.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <span>Version {entry.version}</span>
              <Badge tone={CHANGE_TONE[entry.changeType] ?? 'neutral'}>{entry.changeType}</Badge>
            </span>
          }
          description={
            <>
              {formatDateTime(entry.changedAt)}
              <span aria-hidden="true" className="px-1.5 text-slate-300">
                |
              </span>
              {entry.actorName ? `${entry.actorName} (${entry.actorEmail})` : 'System import'}
            </>
          }
        >
          {entry.note ? <p className="mb-2 text-sm text-slate-700">{entry.note}</p> : null}

          {entry.isBaseline ? (
            <p className="text-sm text-slate-500">
              The untouched imported row. Every later version is measured against this snapshot —
              spec section 5.5.
            </p>
          ) : entry.diffs.length === 0 ? (
            <p className="text-sm text-slate-500">
              No field values differ from the previous version.
            </p>
          ) : (
            <ul className="space-y-2">
              {entry.diffs.map((diff) => (
                <li key={diff.field} className="text-sm">
                  <span className="font-medium text-slate-900">{diff.label}</span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2">
                    <span className="rounded bg-red-50 px-1.5 py-0.5 font-mono text-xs text-red-900 line-through">
                      {diff.from ?? '—'}
                    </span>
                    <span aria-hidden="true" className="text-slate-400">
                      →
                    </span>
                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 font-mono text-xs text-emerald-900">
                      {diff.to ?? '—'}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}
    </div>
  );
}
