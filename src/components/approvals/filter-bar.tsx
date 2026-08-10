import type { ReactNode } from 'react';
import { cx } from '@/components/ui';

/**
 * The filter row every list screen carries, at the density the rest of the page
 * runs at.
 *
 * It was a `Card` holding a four-column grid of 14px labelled controls, which on
 * a queue costs roughly a hundred pixels above the first row — the one thing on
 * the screen anybody came for. A single wrapping flex line of 10px-labelled
 * controls says the same and reads as chrome rather than as content.
 *
 * No margin of its own, and the fields carry no width overrides: both would be
 * a utility the caller then has to fight, and a losing `mb-0` or `basis-24` is a
 * bug that only shows up in the browser. Spacing is the caller's, widths are
 * uniform, and the row wraps.
 *
 * Server component, like the rest of these: a GET form needs no client boundary.
 */

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <form
      method="get"
      className={cx(
        'flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5',
        className,
      )}
    >
      {children}
    </form>
  );
}

export function FilterField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="block min-w-0 grow basis-40">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}
