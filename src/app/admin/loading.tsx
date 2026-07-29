import {
  LoadingScreen,
  SkeletonPageHeader,
  SkeletonStatCards,
  SkeletonTable,
} from '@/components/ui';

/**
 * Fallback for the whole /admin segment.
 *
 * It sits inside admin/layout.tsx, so the shell — sidebar, identity, nav — is
 * already painted by the time this shows and only the content column swaps.
 * That is why the skeleton is page content and not a full-screen overlay.
 *
 * The shape is the segment's common denominator rather than the dashboard's
 * exact layout, because one loading.tsx serves eleven routes. Eight of them are
 * "a band of boxes above one wide table", and that band reads equally as the
 * stat row of /admin, /admin/periods, /admin/users and /admin/audit or as the
 * filter bar /admin/records and /admin/corrections open with. The three routes
 * that are not that shape at all override this file.
 */
export default function AdminLoading() {
  return (
    <LoadingScreen label="Loading admin page">
      <SkeletonPageHeader actions={2} />
      <SkeletonStatCards count={4} />
      <div className="mt-6">
        <SkeletonTable rows={8} columns={6} />
      </div>
    </LoadingScreen>
  );
}
