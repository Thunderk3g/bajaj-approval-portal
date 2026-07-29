import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /sales fallback for one record.
 *
 * A rep opens this from a gap link and lands on grouped field panes, not a
 * table — the segment fallback's stat band and grid would be a straight
 * misdescription of what is loading.
 */
export default function SalesRecordDetailLoading() {
  return (
    <LoadingScreen label="Loading record">
      <SkeletonPageHeader actions={2} />

      <div className="space-y-4">
        <Skeleton height="4.5rem" className="rounded-lg" />

        <div className="grid gap-4 lg:grid-cols-2">
          <Card title={<Skeleton width="6rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={4} />
          </Card>
          <Card title={<Skeleton width="7rem" height="0.875rem" />}>
            <SkeletonDetailRows rows={4} />
          </Card>
        </div>

        <Card title={<Skeleton width="9rem" height="0.875rem" />}>
          <SkeletonDetailRows rows={5} />
        </Card>
      </div>
    </LoadingScreen>
  );
}
