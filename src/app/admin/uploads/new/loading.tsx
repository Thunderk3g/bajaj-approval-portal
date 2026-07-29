import { Card, LoadingScreen, Skeleton, SkeletonFields, SkeletonPageHeader } from '@/components/ui';

/**
 * Overrides the /admin fallback for the upload form.
 *
 * Same reason as the sales request form: a stat band over a table describes a
 * screen to read, and this one is a file picker. Short as this wait is, the
 * wrong skeleton is more disorienting than a brief one that fits.
 */
export default function NewUploadLoading() {
  return (
    <LoadingScreen label="Loading upload form">
      <SkeletonPageHeader />

      <Card>
        <SkeletonFields count={2} />
        <div className="mt-5 space-y-4">
          <Skeleton height="5rem" className="rounded-lg" />
          <Skeleton width="8rem" height="2.375rem" />
        </div>
      </Card>
    </LoadingScreen>
  );
}
