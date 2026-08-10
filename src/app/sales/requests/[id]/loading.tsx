import { Card, LoadingScreen, Skeleton } from '@/components/ui';

/**
 * Overrides the /sales fallback for one request.
 *
 * Progress on the left, the change and the proof on the right — the shape the
 * page settles into. The segment fallback's single wide table would collapse to
 * one column and then jump into two, which is exactly the shift that moves the
 * withdraw button out from under a rep's cursor.
 */
export default function SalesRequestDetailLoading() {
  return (
    <LoadingScreen label="Loading correction request">
      <div className="mb-4">
        <Skeleton width="7rem" height="0.75rem" />
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <Skeleton width="11rem" height="1.5rem" />
          <Skeleton width="4rem" height="1.125rem" />
          <Skeleton width="4.5rem" height="1.125rem" />
        </div>
        <Skeleton width="24rem" height="0.875rem" className="mt-2 max-w-full" />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Card title={<Skeleton width="10rem" height="0.875rem" />}>
          <div className="space-y-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-3">
                <Skeleton width="0.625rem" height="0.625rem" className="mt-1 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton width="12rem" height="0.875rem" />
                  <Skeleton width="7rem" height="0.75rem" />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title={<Skeleton width="6rem" height="0.875rem" />}>
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1].map((i) => (
                <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3">
                  <Skeleton width="4rem" height="0.625rem" />
                  <Skeleton width="70%" height="1.25rem" />
                </div>
              ))}
            </div>
          </Card>

          <Card title={<Skeleton width="9rem" height="0.875rem" />}>
            <div className="space-y-2">
              <Skeleton height="3.75rem" className="rounded-md" />
              <Skeleton height="3.75rem" className="rounded-md" />
            </div>
          </Card>
        </div>
      </div>
    </LoadingScreen>
  );
}
