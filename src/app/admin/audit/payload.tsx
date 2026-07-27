import { describePayload } from './diff';

/**
 * Renders one row's before/after payload.
 *
 * Collapsed behind a <details> because it works with JavaScript disabled and
 * because an audit page is scanned far more often than it is read line by line:
 * twenty-five expanded JSON blobs would bury the actor/action columns that most
 * queries are actually looking for.
 */
export function AuditPayload({ before, after }: { before: unknown; after: unknown }) {
  const shape = describePayload(before, after);

  if (shape.kind === 'none') {
    return <span className="text-slate-400">—</span>;
  }

  if (shape.kind === 'diff') {
    if (shape.entries.length === 0) {
      // Both sides present and identical. Saying so is more useful than an
      // empty cell, which reads as "no payload was recorded".
      return <span className="text-slate-400">no field changed</span>;
    }

    return (
      <details className="group">
        <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900">
          {shape.entries.length} field{shape.entries.length === 1 ? '' : 's'} changed
        </summary>
        <dl className="mt-1.5 space-y-1">
          {shape.entries.map((entry) => (
            <div key={entry.key} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <dt className="font-mono font-medium text-slate-700">{entry.key}</dt>
              <dd className="min-w-0 break-all">
                <span className="text-red-700 line-through">{entry.before ?? '(absent)'}</span>
                <span aria-hidden="true" className="px-1 text-slate-400">
                  →
                </span>
                <span className="text-emerald-700">{entry.after ?? '(absent)'}</span>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    );
  }

  return (
    <details className="group">
      <summary className="cursor-pointer text-xs font-medium text-slate-600 hover:text-slate-900">
        {shape.before && shape.after ? 'payload' : shape.after ? 'after' : 'before'}
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {shape.before ? <JsonBlock label="Before" json={shape.before} /> : null}
        {shape.after ? <JsonBlock label="After" json={shape.after} /> : null}
      </div>
    </details>
  );
}

function JsonBlock({ label, json }: { label: string; json: string }) {
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <pre className="mt-0.5 max-h-48 overflow-auto rounded bg-slate-50 p-2 text-[11px] leading-tight text-slate-700">
        {json}
      </pre>
    </div>
  );
}
