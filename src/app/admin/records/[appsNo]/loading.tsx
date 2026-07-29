import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /admin fallback for one record.
 *
 * This is the one admin shape with neither a stat row nor a grid: it is a
 * header, a gap banner, six grouped field panes and a version history. The
 * segment fallback would promise a wide table that never arrives, and the
 * reflow when the real page lands is worse than no skeleton at all.
 */
export default function AdminRecordDetailLoading() {
  return (
    <LoadingScreen label="Loading record">
      <SkeletonPageHeader actions={1} />

      <div className="space-y-4">
        {/* The gaps banner. It is on this page whether or not there are gaps —
            "no reconciliation gaps" is itself an alert — so reserving its
            height is safe rather than optimistic. */}
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
