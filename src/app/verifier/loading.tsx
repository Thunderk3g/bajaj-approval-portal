import {
  LoadingScreen,
  SkeletonPageHeader,
  SkeletonStatCards,
  SkeletonTable,
} from '@/components/ui';

/**
 * Fallback for /verifier, /verifier/queue and /verifier/history.
 *
 * The verifier screens mirror the approver's, so this mirrors the approver
 * fallback. Kept as its own file rather than a shared export because a
 * loading.tsx is a route convention, not a component — hoisting it somewhere
 * shared would only hide which segments are actually covered.
 */
export default function VerifierLoading() {
  return (
    <LoadingScreen label="Loading verifier page">
      <SkeletonPageHeader actions={1} />
      <SkeletonStatCards count={4} />
      <div className="mt-6">
        <SkeletonTable rows={8} columns={8} />
      </div>
    </LoadingScreen>
  );
}
