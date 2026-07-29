import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /verifier fallback for the verification screen, for the same
 * reason as its approver twin: the queue skeleton would read as a click that
 * never left the list, and this page is the segment's heaviest read.
 */
export default function VerifierRequestLoading() {
  return (
    <LoadingScreen label="Loading correction request">
      <SkeletonPageHeader actions={1} />

      <div className="space-y-4">
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

        <Card title={<Skeleton width="7rem" height="0.875rem" />}>
          <div className="space-y-4">
            <Skeleton width="5rem" height="0.875rem" />
            <Skeleton height="6rem" />
            <div className="flex flex-wrap gap-2">
              <Skeleton width="9rem" height="2.375rem" />
              <Skeleton width="13rem" height="2.375rem" />
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
