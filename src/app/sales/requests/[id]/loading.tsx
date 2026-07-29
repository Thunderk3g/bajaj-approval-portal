import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /sales fallback for one request.
 *
 * The only three-column layout in the app — correction and history on the left,
 * proof and actions on the right. The segment fallback's single wide table
 * would collapse to one column and then jump into three, which is exactly the
 * shift that moves the withdraw button out from under a rep's cursor.
 */
export default function SalesRequestDetailLoading() {
  return (
    <LoadingScreen label="Loading correction request">
      <SkeletonPageHeader actions={2} />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title={<Skeleton width="9rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={5} />
          </Card>
          <Card title={<Skeleton width="6rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={4} />
          </Card>
        </div>

        <div className="space-y-4">
          <Card title={<Skeleton width="4rem" height="0.875rem" />}>
            <div className="space-y-2">
              <Skeleton height="3rem" className="rounded-lg" />
              <Skeleton height="3rem" className="rounded-lg" />
            </div>
          </Card>
        </div>
      </div>
    </LoadingScreen>
  );
}
