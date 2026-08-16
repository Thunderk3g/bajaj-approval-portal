import type { Metadata } from 'next';
import { EmptyState, LinkButton } from '@/components/ui';

export const metadata: Metadata = {
  title: 'Not found · Sales Data Review Portal',
};

/**
 * Every `notFound()` in the portal lands here, plus any URL that matches no
 * route at all.
 *
 * Worded the way the record and request pages mean it. Both call `notFound()`
 * for a row that exists but is not yours as well as for one that does not
 * exist — see the comment in `/sales/requests/[id]` — so this page must not
 * claim the thing is missing. "Not found, or not yours" covers both without
 * confirming which, and confirming which is how a curious user maps out
 * somebody else's book one id at a time.
 *
 * The link is `/`, not a role dashboard: the root already routes each signed-in
 * user to their own and sends everyone else to the login screen, which is the
 * same answer this page would have to work out for itself — and working it out
 * here would make the framework's own 404 a dynamic, session-reading render.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-lg">
        <EmptyState
          title="That page was not found"
          description="The record, request or screen behind this address either does not exist, was removed, or is not one your account can open. Check the link, or start again from your dashboard."
        />
        <div className="mt-4 flex justify-center">
          <LinkButton href="/">Back to my dashboard</LinkButton>
        </div>
      </div>
    </main>
  );
}
