import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /approver fallback for the decision screen.
 *
 * This is the slowest hop in the approver's day — one request pulls the record,
 * the roster mapping, the proofs, the event timeline and the version trail — and
 * it is the shape least like the queue it was reached from. Showing the queue
 * skeleton here would suggest the click missed and landed back on the list.
 *
 * The decision card is given its real height deliberately: the approver's hand
 * is already moving towards it, and a card that grows underneath the cursor is
 * how a "Reject" gets clicked instead of a "Return".
 */
export default function ApproverRequestLoading() {
  return (
    <LoadingScreen label="Loading correction request">
      <SkeletonPageHeader actions={1} />

      <div className="space-y-4">
        {/* Submitted / current / proposed, side by side. */}
        <Card title={<Skeleton width="10rem" height="0.875rem" />}>
          <div className="grid gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton width="6rem" height="0.75rem" />
                <Skeleton width="80%" height="1.25rem" />
              </div>
            ))}
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={<Skeleton width="8rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={5} />
          </Card>
          <Card title={<Skeleton width="5rem" height="0.875rem" />}>
            <div className="space-y-2">
              <Skeleton height="3rem" className="rounded-lg" />
              <Skeleton height="3rem" className="rounded-lg" />
            </div>
          </Card>
        </div>

        <Card title={<Skeleton width="6rem" height="0.875rem" />}>
          <div className="space-y-4">
            <Skeleton width="5rem" height="0.875rem" />
            <Skeleton height="6rem" />
            <div className="flex flex-wrap gap-2">
              <Skeleton width="10rem" height="2.375rem" />
              <Skeleton width="13rem" height="2.375rem" />
              <Skeleton width="6rem" height="2.375rem" />
            </div>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={<Skeleton width="6rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={4} />
          </Card>
          <Card title={<Skeleton width="10rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={4} />
          </Card>
        </div>
      </div>
    </LoadingScreen>
  );
}
