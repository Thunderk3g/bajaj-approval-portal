import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /tl fallback for one record.
 *
 * The segment fallback is a stat band over a wide table, which is a straight
 * misdescription of a detail page: grouped field panes, no grid. Same shape as
 * the rep's own record detail, because it is the same screen.
 */
export default function TeamLeaderRecordDetailLoading() {
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
