import {
  LoadingScreen,
  SkeletonPageHeader,
  SkeletonStatCards,
  SkeletonTable,
} from '@/components/ui';

/**
 * Fallback for the whole /sales segment.
 *
 * Same common-denominator reasoning as the admin fallback: the dashboard, the
 * record list and the request list all lead with a band of boxes over one wide
 * table, so this covers three of the six sales routes accurately and the rest
 * override it. Two stat cards rather than four — a rep sees a narrower band
 * than an admin does on every screen this covers.
 */
export default function SalesLoading() {
  return (
    <LoadingScreen label="Loading your page">
      <SkeletonPageHeader actions={2} />
      <SkeletonStatCards count={2} className="sm:grid-cols-2 xl:grid-cols-2" />
      <div className="mt-6">
        <SkeletonTable rows={8} columns={5} />
      </div>
    </LoadingScreen>
  );
}
