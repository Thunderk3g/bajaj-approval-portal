import { Card, LoadingScreen, Skeleton, SkeletonFields, SkeletonPageHeader } from '@/components/ui';

/**
 * Overrides the /sales fallback for the raise-a-request form.
 *
 * A form is the one shape where a table skeleton actively misleads: the rep
 * arrives here to type, and a grid of rows says the page is something to read.
 */
export default function NewRequestLoading() {
  return (
    <LoadingScreen label="Loading correction request form">
      <SkeletonPageHeader />

      <Card>
        <SkeletonFields count={4} />
        {/* The proof dropzone and the submit row, which sit below the fields
            and are the whole point of the screen. */}
        <div className="mt-5 space-y-4">
          <Skeleton height="5rem" className="rounded-lg" />
          <Skeleton width="9rem" height="2.375rem" />
        </div>
      </Card>
    </LoadingScreen>
  );
}
