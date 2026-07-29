import {
  LoadingScreen,
  SkeletonPageHeader,
  SkeletonStatCards,
  SkeletonTable,
} from '@/components/ui';

/**
 * Fallback for /approver, /approver/queue and /approver/history.
 *
 * All three are a stat or filter band over one wide table, so a single file
 * covers the segment honestly; only the decision screen underneath
 * /approver/requests/[id] needs its own. Eight columns because that is what the
 * queue and history tables actually carry — a five-column stand-in would
 * visibly reflow the moment the rows arrive.
 */
export default function ApproverLoading() {
  return (
    <LoadingScreen label="Loading approver page">
      <SkeletonPageHeader actions={1} />
      <SkeletonStatCards count={4} />
      <div className="mt-6">
        <SkeletonTable rows={8} columns={8} />
      </div>
    </LoadingScreen>
  );
}
