import {
  LoadingScreen,
  SkeletonPageHeader,
  SkeletonStatCards,
  SkeletonTable,
} from '@/components/ui';

/**
 * Fallback for every /acm route. Mirrors the team leader's, because the screens
 * behind it are literally the same components at a wider scope.
 */
export default function AreaManagerLoading() {
  return (
    <LoadingScreen label="Loading area manager page">
      <SkeletonPageHeader actions={1} />
      <SkeletonStatCards count={4} />
      <div className="mt-4">
        <SkeletonTable rows={8} columns={7} />
      </div>
    </LoadingScreen>
  );
}
