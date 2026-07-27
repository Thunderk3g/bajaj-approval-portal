import { Badge } from '@/components/ui';
import { detectGaps, GAP_LABELS, type GapCandidate } from '@/lib/records/gaps';

/**
 * Gap flags for one record, rendered from `detectGaps` rather than from the
 * query that selected the row.
 *
 * The SQL in query.ts decides *which* rows are listed; this decides what each
 * one is missing. Both are derived from the same section 6.4 rule, and
 * tests/integration/records-gaps.test.ts asserts they agree — but the badge
 * reads the record in front of it, so a row that arrived through an unfiltered
 * search is labelled just as accurately as one from the gap queue.
 */
export function GapBadges({
  record,
  emptyLabel = '—',
}: {
  record: GapCandidate;
  emptyLabel?: string;
}) {
  const gaps = detectGaps(record);

  if (gaps.length === 0) {
    return (
      <span className="text-slate-400" title="No gap: section 6.4 only counts blanks on ISSUED rows">
        {emptyLabel}
      </span>
    );
  }

  return (
    <span className="flex flex-wrap gap-1">
      {gaps.map((gap) => (
        // Missing policy number on an ISSUED row is the true anomaly — three in
        // the June file — so it is the only one coloured as an error.
        <Badge key={gap} tone={gap === 'MISSING_POLICY_NO' ? 'danger' : 'warning'}>
          {GAP_LABELS[gap]}
        </Badge>
      ))}
    </span>
  );
}
