import { Card, LoadingScreen, Skeleton, SkeletonDetailRows } from '@/components/ui';

/**
 * Overrides the /verifier fallback for the verification screen, for the same
 * reason as its approver twin: the queue skeleton would read as a click that
 * never left the list, and this page is the segment's heaviest read.
 *
 * Two buttons in the rail rather than three — a verifier has no terminal reject,
 * and a placeholder that promised one would settle into a shorter panel.
 */
export default function VerifierRequestLoading() {
  return (
    <LoadingScreen label="Loading correction request">
      <div className="mb-4">
        <Skeleton width="8rem" height="0.75rem" />
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Skeleton width="11rem" height="1.5rem" />
          <Skeleton width="4rem" height="1.125rem" />
          <Skeleton width="4.5rem" height="1.125rem" />
        </div>
        <Skeleton width="26rem" height="0.875rem" className="mt-2 max-w-full" />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-4">
          <Card title={<Skeleton width="12rem" height="0.875rem" />}>
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1].map((i) => (
                <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3">
                  <Skeleton width="9rem" height="0.625rem" />
                  <Skeleton width="60%" height="1.75rem" />
                  <Skeleton width="80%" height="0.75rem" />
                </div>
              ))}
            </div>
          </Card>

          <Card title={<Skeleton width="8rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={6} />
          </Card>

          <Card title={<Skeleton width="5rem" height="0.875rem" />}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height="9rem" className="rounded-md" />
              ))}
            </div>
          </Card>

          <Card title={<Skeleton width="10rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={4} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={<Skeleton width="7rem" height="0.875rem" />}>
            <div className="space-y-4">
              <Skeleton width="5rem" height="0.875rem" />
              <Skeleton height="6rem" />
              <div className="space-y-2">
                <Skeleton height="2rem" />
                <Skeleton height="2rem" />
              </div>
            </div>
          </Card>
        </div>
      </div>
    </LoadingScreen>
  );
}
