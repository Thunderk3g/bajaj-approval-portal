import { Card, LoadingScreen, Skeleton, SkeletonPageHeader } from '@/components/ui';

/**
 * Overrides the /admin fallback for the import wizard.
 *
 * This route is the longest wait in the portal by a wide margin — it opens the
 * stored workbook and parses a sheet before it can render anything — so it is
 * the one place a missing loading state was most costly. It is also a stack of
 * numbered step cards rather than a table, and an admin who cannot tell whether
 * a slow parse is running will re-upload the same file.
 *
 * The rail is drawn first, at the height the real one occupies, because it is
 * now the first thing under the header and a skeleton that omits it makes the
 * whole page jump on swap.
 */
export default function UploadDetailLoading() {
  return (
    <LoadingScreen label="Loading upload — reading the workbook">
      <SkeletonPageHeader actions={2} />

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Skeleton width="1.125rem" height="1.125rem" className="rounded-full" />
              <Skeleton width="2.75rem" height="0.6875rem" />
            </div>
          ))}
        </div>

        {/* One block per wizard step. Which steps are live depends on how far
            the batch has got, so these are sized for the common case — a batch
            that is open and awaiting its mapping — rather than for all five. */}
        <Card title={<Skeleton width="12rem" height="0.875rem" />}>
          <Skeleton height="4rem" />
        </Card>

        <Card title={<Skeleton width="10rem" height="0.875rem" />}>
          <Skeleton height="10rem" />
        </Card>

        <Card title={<Skeleton width="8rem" height="0.875rem" />}>
          <Skeleton height="3rem" />
        </Card>
      </div>
    </LoadingScreen>
  );
}
