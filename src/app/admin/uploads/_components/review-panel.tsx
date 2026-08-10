'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { abortBatchAction, commitBatchAction, validateBatchAction } from '@/lib/import/actions';
import type { ValidationReport } from '@/lib/import/types';
import { Alert, Button, Card, StatCard, Table, Td, Th } from '@/components/ui';

/** Enough rows to see the shape of a problem without rendering a 54,000-row table. */
const VISIBLE = 50;

function conflictKey(appsNo: string, field: string): string {
  return `${appsNo}::${field}`;
}

/**
 * The second human gate: the error report before commit — spec sections 6.5 and 6.8.
 *
 * Rows with errors are listed with their worksheet row numbers, so a skipped
 * row is visible rather than merely absent. Conflicts default to UNCHECKED:
 * the approved, evidenced value stays unless the admin deliberately says
 * otherwise, because silently reverting one is the worst thing this pipeline
 * could do.
 */
export function ReviewPanel({
  batchId,
  report,
  committable,
}: {
  batchId: string;
  report: ValidationReport;
  committable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Set<string>>(new Set());

  function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? 'That did not work.');
        return;
      }
      router.refresh();
    });
  }

  function commit() {
    const acceptedConflicts: Record<string, string[]> = {};
    for (const conflict of report.conflicts) {
      if (!accepted.has(conflictKey(conflict.appsNo, conflict.field))) continue;
      (acceptedConflicts[conflict.appsNo] ??= []).push(conflict.field);
    }
    run(() => commitBatchAction({ batchId, acceptedConflicts }));
  }

  const { totals } = report;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Rows parsed" value={totals.rows.toLocaleString('en-IN')} />
        <StatCard label="Will commit" value={totals.valid.toLocaleString('en-IN')} tone="success" />
        <StatCard
          label="Blocked by errors"
          value={totals.invalid.toLocaleString('en-IN')}
          tone={totals.invalid > 0 ? 'danger' : 'default'}
        />
        <StatCard
          label="Duplicates"
          value={totals.duplicate.toLocaleString('en-IN')}
          tone={totals.duplicate > 0 ? 'warning' : 'default'}
        />
        <StatCard label="New records" value={totals.newRecords.toLocaleString('en-IN')} />
        <StatCard
          label="Conflicts"
          value={totals.conflicts.toLocaleString('en-IN')}
          tone={totals.conflicts > 0 ? 'warning' : 'default'}
          hint="Approved corrections the file disagrees with"
        />
      </div>

      {report.truncated ? (
        <Alert tone="warning" title="This report is truncated">
          Only the first {VISIBLE} of each problem type are shown, and the stored report itself is
          capped. Fix the mapping and re-validate if the counts look wrong for this file.
        </Alert>
      ) : null}

      {report.conflicts.length > 0 ? (
        <Card
          title="Conflicts with approved corrections"
          description="The stored value is kept unless you tick the box. Accepting writes a re-import version and an audit entry."
        >
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Apps_No</Th>
                <Th>Field</Th>
                <Th>Approved value (kept)</Th>
                <Th>Value in this file</Th>
                <Th>Accept file value</Th>
              </tr>
            </thead>
            <tbody>
              {report.conflicts.slice(0, VISIBLE).map((conflict) => {
                const key = conflictKey(conflict.appsNo, conflict.field);
                return (
                  <tr key={key}>
                    <Td className="tabular-nums">{conflict.rowNumber}</Td>
                    <Td className="font-mono text-[12px]">{conflict.appsNo}</Td>
                    <Td className="text-[12px]">{conflict.label}</Td>
                    {/* Both values monospaced: the whole decision on this row is
                        whether two strings differ in a way that matters. */}
                    <Td className="font-mono text-[12px] font-medium text-emerald-800">
                      {conflict.currentValue ?? '—'}
                    </Td>
                    <Td className="font-mono text-[12px] text-amber-800">
                      {conflict.incomingValue ?? '—'}
                    </Td>
                    <Td>
                      <input
                        type="checkbox"
                        aria-label={`Accept the file value for ${conflict.label} on ${conflict.appsNo}`}
                        checked={accepted.has(key)}
                        disabled={pending || !committable}
                        onChange={(e) =>
                          setAccepted((current) => {
                            const next = new Set(current);
                            if (e.target.checked) next.add(key);
                            else next.delete(key);
                            return next;
                          })
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {report.errors.length > 0 ? (
        <Card
          title={`${totals.invalid} row${totals.invalid === 1 ? '' : 's'} will be skipped`}
          description="Row numbers are worksheet rows, so they match what you see in Excel."
        >
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Apps_No</Th>
                <Th>Problem</Th>
              </tr>
            </thead>
            <tbody>
              {report.errors.slice(0, VISIBLE).map((problem) => (
                <tr key={problem.rowNumber}>
                  <Td className="tabular-nums">{problem.rowNumber}</Td>
                  <Td className="font-mono text-[12px]">{problem.appsNo ?? '—'}</Td>
                  <Td>
                    {problem.issues.map((issue, index) => (
                      <p key={`${issue.code}-${index}`} className="text-[12px] text-red-800">
                        {issue.message}
                      </p>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {report.duplicates.length > 0 ? (
        <Card
          title="Duplicate Apps_No within this file"
          description="The first occurrence is authoritative; later ones are held back, not dropped."
        >
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Apps_No</Th>
                <Th>First seen on row</Th>
              </tr>
            </thead>
            <tbody>
              {report.duplicates.slice(0, VISIBLE).map((duplicate) => (
                <tr key={duplicate.rowNumber}>
                  <Td className="tabular-nums">{duplicate.rowNumber}</Td>
                  <Td className="font-mono text-[12px]">{duplicate.appsNo}</Td>
                  <Td className="tabular-nums">{duplicate.duplicateOfRow}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {report.warnings.length > 0 ? (
        <Card
          title={`${report.warnings.length} row${report.warnings.length === 1 ? '' : 's'} with warnings`}
          description="These commit. They are recorded so nothing is fixed silently."
        >
          <Table>
            <thead>
              <tr>
                <Th>Row</Th>
                <Th>Apps_No</Th>
                <Th>Warning</Th>
              </tr>
            </thead>
            <tbody>
              {report.warnings.slice(0, VISIBLE).map((problem) => (
                <tr key={problem.rowNumber}>
                  <Td className="tabular-nums">{problem.rowNumber}</Td>
                  <Td className="font-mono text-[12px]">{problem.appsNo ?? '—'}</Td>
                  <Td>
                    {problem.issues.map((issue, index) => (
                      <p key={`${issue.code}-${index}`} className="text-[12px] text-amber-800">
                        {issue.message}
                      </p>
                    ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {committable ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={commit} disabled={pending}>
            {pending
              ? 'Committing…'
              : `Commit ${totals.valid.toLocaleString('en-IN')} row${totals.valid === 1 ? '' : 's'}`}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            onClick={() => run(() => validateBatchAction({ batchId }))}
          >
            Re-validate
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={pending}
            onClick={() => run(() => abortBatchAction({ batchId, reason: 'Aborted from the review screen' }))}
          >
            Abort batch
          </Button>
        </div>
      ) : null}
    </div>
  );
}
