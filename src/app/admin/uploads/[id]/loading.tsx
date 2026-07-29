import {
  Card,
  LoadingScreen,
  Skeleton,
  SkeletonDetailRows,
  SkeletonPageHeader,
} from '@/components/ui';

/**
 * Overrides the /admin fallback for the import wizard.
 *
 * This route is the longest wait in the portal by a wide margin — it opens the
 * stored workbook and parses a sheet before it can render anything — so it is
 * the one place a missing loading state was most costly. It is also a stack of
 * numbered step cards rather than a table, and an admin who cannot tell whether
 * a slow parse is running will re-upload the same file.
 */
export default function UploadDetailLoading() {
  return (
    <LoadingScreen label="Loading upload — reading the workbook">
      <SkeletonPageHeader actions={2} />

      <div className="space-y-6">
        <Card title={<Skeleton width="6rem" height="0.875rem" />}>
          <SkeletonDetailRows rows={5} />
        </Card>

        {/* One block per wizard step. Which steps are live depends on how far
            the batch has got, so these are sized for the common case — a batch
            that is open and awaiting its mapping — rather than for all four. */}
        <Card title={<Skeleton width="12rem" height="0.875rem" />}>
          <Skeleton height="6rem" />
        </Card>

        <Card title={<Skeleton width="10rem" height="0.875rem" />}>
          <Skeleton height="10rem" />
        </Card>
      </div>
    </LoadingScreen>
  );
}
