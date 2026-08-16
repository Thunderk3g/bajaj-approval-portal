import { Card, LoadingScreen, Skeleton, SkeletonDetailRows } from '@/components/ui';

/**
 * Overrides the /acm fallback for the review screen — the team leader's twin.
 *
 * The two manager screens are one component (`ManagerRequestScreen`), so the
 * placeholder is the same box in both places: the 1.6fr/1fr split, the chain
 * between the proof and the version trail, and two buttons in the rail rather
 * than three, because a mid-chain manager passes it on or sends it back and
 * only the final rung rejects.
 */
export default function AreaManagerRequestLoading() {
  return (
    <LoadingScreen label="Loading correction request">
      <div className="mb-4">
        <Skeleton width="8rem" height="0.75rem" />
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Skeleton width="11rem" height="1.5rem" />
          <Skeleton width="4rem" height="1.125rem" />
          <Skeleton width="4.5rem" height="1.125rem" />
          <Skeleton width="5rem" height="1.125rem" />
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
            <div className="space-y-3.5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-3">
                  <Skeleton width="1.25rem" height="1.25rem" className="rounded-full" />
                  <div className="min-w-0 flex-1 space-y-1">
                    <Skeleton width="14rem" height="0.8125rem" />
                    <Skeleton width="9rem" height="0.8125rem" />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title={<Skeleton width="6rem" height="0.875rem" />}>
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
