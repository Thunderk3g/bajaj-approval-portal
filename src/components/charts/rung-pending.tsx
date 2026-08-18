'use client';

import { useLinkStatus } from 'next/link';

/**
 * "This link is loading" — the one thing the rung switcher could not say.
 *
 * Changing a query string on the route you are already on re-triggers no
 * `loading.tsx`: the segment does not change, so React keeps the current UI
 * mounted for the whole of the transition and Next does not move the address bar
 * until it commits. Nothing on screen moves and the URL does not change, which
 * is indistinguishable from a button that does not work — and is exactly how the
 * heaviest grouping was reported.
 *
 * `useLinkStatus` is Next's own answer to that (15.3+) and needs no state of its
 * own: it reads the pending status of the enclosing `<Link>`. This is the only
 * client component on the performance screen, and it is a leaf that renders one
 * span — the report itself stays a server component.
 */
export function RungPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;

  return (
    <span
      role="status"
      aria-label="Loading"
      className="ml-0.5 inline-block size-3 shrink-0 rounded-full border-2 border-current border-r-transparent align-[-1px] motion-safe:animate-spin"
    />
  );
}
