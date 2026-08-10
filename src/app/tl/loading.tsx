import {
  LoadingScreen,
  SkeletonPageHeader,
  SkeletonStatCards,
  SkeletonTable,
} from '@/components/ui';

/**
 * Fallback for every /tl route — dashboard, queue, team and one request.
 *
 * The segment had none, so each of those hops held the previous page until
 * Postgres answered, which reads as a dead click and gets clicked again. One
 * fallback for the whole segment rather than four: the three list screens share
 * this shape, and the request screen is reached from a row on it.
 */
export default function TeamLeaderLoading() {
  return (
    <LoadingScreen label="Loading team leader page">
      <SkeletonPageHeader actions={1} />
      <SkeletonStatCards count={4} />
      <div className="mt-4">
        <SkeletonTable rows={8} columns={7} />
      </div>
    </LoadingScreen>
  );
}
