import type { ComponentProps, ReactNode } from 'react';
import Link from 'next/link';

/**
 * Shared presentational primitives.
 *
 * Deliberately server components with no client-side state: every one of these
 * renders inside a Server Component page, and marking them 'use client' would
 * drag whole page trees into the browser bundle for the sake of a border
 * colour. Anything interactive lives in its own client component alongside the
 * feature that needs it.
 *
 * The palette matches the existing shell (slate on white) rather than
 * introducing a second visual language.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description ? (
          <div className="mt-1.5 max-w-2xl text-sm text-slate-600">{description}</div>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-slate-900">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-slate-500">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  href,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
}) {
  const tones = {
    default: 'text-slate-900',
    warning: 'text-amber-700',
    danger: 'text-red-700',
    success: 'text-emerald-700',
  } as const;

  const body = (
    <>
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </>
  );

  const className =
    'block rounded-lg border border-slate-200 bg-white p-4' +
    (href ? ' transition-colors hover:border-slate-300 hover:bg-slate-50' : '');

  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/* ----------------------------------------------------------------- content */

export function EmptyState({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
    </div>
  );
}

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  title?: ReactNode;
  children?: ReactNode;
}) {
  const tones = {
    info: 'border-slate-200 bg-slate-50 text-slate-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-red-200 bg-red-50 text-red-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  } as const;

  return (
    <div className={cx('rounded border px-3 py-2 text-sm', tones[tone])} role="alert">
      {title ? <p className="font-medium">{title}</p> : null}
      {children ? <div className={title ? 'mt-0.5' : undefined}>{children}</div> : null}
    </div>
  );
}

export type BadgeTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const tones: Record<BadgeTone, string> = {
    neutral: 'border-slate-200 bg-slate-100 text-slate-700',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    danger: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  };

  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/** One vocabulary for correction status colour, shared by every screen. */
export const STATUS_TONE: Record<string, BadgeTone> = {
  PENDING: 'warning',
  // Info, not success: verification is progress, not an outcome. Colouring it
  // green would read to a rep as "your correction went through" while the
  // record still holds the old value and an approver has yet to look at it.
  VERIFIED: 'info',
  APPROVED: 'success',
  REJECTED: 'danger',
  RETURNED: 'info',
  // Neutral, not danger: the rep closed this themselves. Colouring a withdrawal
  // like a rejection would read as a verdict nobody delivered.
  WITHDRAWN: 'neutral',
  DRAFT: 'neutral',
  MAPPED: 'info',
  VALIDATED: 'info',
  COMMITTED: 'success',
  FAILED: 'danger',
  ABORTED: 'neutral',
  VALID: 'success',
  INVALID: 'danger',
  DUPLICATE: 'warning',
  SKIPPED: 'neutral',
  ISSUED: 'success',
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return <Badge tone={STATUS_TONE[status.toUpperCase()] ?? 'neutral'}>{status}</Badge>;
}

/* ------------------------------------------------------------------- table */

export function Table({ children }: { children: ReactNode }) {
  // The wrapper scrolls, not the page: a wide record grid must never make the
  // whole document scroll sideways.
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="w-full min-w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className, ...rest }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cx(
        'border-b border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap',
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, ...rest }: ComponentProps<'td'>) {
  return (
    <td className={cx('border-b border-slate-100 px-3 py-2 align-top text-slate-800', className)} {...rest}>
      {children}
    </td>
  );
}

/** Definition row for detail panes — label left, value right. */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-0.5 border-b border-slate-100 py-2 last:border-b-0">
      <dt className="w-48 shrink-0 text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

const CONTROL =
  'w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-500';

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | string[] | null;
  required?: boolean;
  children: ReactNode;
}) {
  const messages = error ? (Array.isArray(error) ? error : [error]) : [];
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
        {required ? (
          <span className="ml-0.5 text-red-600" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
      {messages.map((m) => (
        <p key={m} className="text-xs text-red-700">
          {m}
        </p>
      ))}
    </div>
  );
}

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return <input className={cx(CONTROL, className)} {...rest} />;
}

export function Textarea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(CONTROL, 'min-h-24', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <select className={cx(CONTROL, className)} {...rest}>
      {children}
    </select>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800 focus:ring-slate-500',
  secondary:
    'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus:ring-slate-400',
  danger: 'bg-red-700 text-white hover:bg-red-800 focus:ring-red-500',
  ghost: 'text-slate-700 hover:bg-slate-100 focus:ring-slate-400',
};

export function buttonClass(variant: ButtonVariant = 'primary', className?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className);
}

export function Button({
  variant = 'primary',
  className,
  ...rest
}: ComponentProps<'button'> & { variant?: ButtonVariant }) {
  return <button className={buttonClass(variant, className)} {...rest} />;
}

export function LinkButton({
  variant = 'secondary',
  className,
  ...rest
}: ComponentProps<typeof Link> & { variant?: ButtonVariant }) {
  return <Link className={buttonClass(variant, className)} {...rest} />;
}

/* ----------------------------------------------------------------- loading */

/**
 * Skeletons rather than a spinner, because the wait here is a page wait.
 *
 * Every route in this portal is force-dynamic and queries Postgres before it
 * renders, so a click costs anywhere from half a second to several. Without
 * something on screen the browser holds the *previous* page, which reads as a
 * dead click and gets clicked again.
 *
 * The pulse is gated behind `motion-safe:`. An animation nobody can turn off is
 * a vestibular trigger, and under `prefers-reduced-motion: reduce` these blocks
 * settle to the flat slate tint — still legibly a placeholder, just still.
 *
 * These are server components like everything else in this file: a CSS
 * animation needs no client boundary, and marking them 'use client' would drag
 * every loading.tsx into the browser bundle.
 */
export function Skeleton({
  width,
  height = '1rem',
  className,
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cx('block rounded bg-slate-200 motion-safe:animate-pulse', className)}
      style={{ width, height }}
    />
  );
}

/**
 * The root of every loading.tsx.
 *
 * A screen reader must hear one sentence, not forty empty boxes: the label is
 * the only thing exposed and the placeholder tree is hidden outright.
 * `aria-busy` is what distinguishes "this region is mid-update" from "this
 * region finished and is empty" — without it the honest reading of a skeleton
 * page is that the query returned nothing.
 */
export function LoadingScreen({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

/**
 * Fixed cycle rather than randomised widths.
 *
 * A loading.tsx is server-rendered and then hydrated; Math.random() would build
 * two different trees and throw a hydration mismatch on exactly the slow
 * navigations this exists to cover.
 */
const SKELETON_WIDTHS = ['72%', '45%', '88%', '58%', '36%', '66%'];

/** Mirrors {@link PageHeader}, down to its `mb-6`, so nothing shifts on swap. */
export function SkeletonPageHeader({ actions = 0 }: { actions?: number }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Skeleton width="16rem" height="1.5rem" className="max-w-full" />
        <Skeleton width="28rem" height="0.875rem" className="mt-2 max-w-full" />
      </div>
      {actions > 0 ? (
        <div className="flex shrink-0 items-center gap-2">
          {Array.from({ length: actions }, (_, i) => (
            <Skeleton key={i} width="7rem" height="2.375rem" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Mirrors {@link StatCard}: label, value, hint, in a card of the same box. */
export function SkeletonStatCards({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cx('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-lg border border-slate-200 bg-white p-4">
          <Skeleton width="45%" height="0.75rem" />
          <Skeleton width="30%" height="1.75rem" className="mt-1.5" />
          <Skeleton width="60%" height="0.75rem" className="mt-1.5" />
        </div>
      ))}
    </div>
  );
}

/** Built from the real {@link Table}/{@link Th}/{@link Td} so the swap is a fill, not a relayout. */
export function SkeletonTable({ rows = 8, columns = 5 }: { rows?: number; columns?: number }) {
  const cols = Array.from({ length: columns }, (_, i) => i);

  return (
    <Table>
      <thead>
        <tr>
          {cols.map((col) => (
            <Th key={col}>
              <Skeleton width="70%" height="0.75rem" />
            </Th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          <tr key={row}>
            {cols.map((col) => (
              <Td key={col}>
                <Skeleton
                  width={SKELETON_WIDTHS[(row + col) % SKELETON_WIDTHS.length]}
                  height="0.875rem"
                />
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Mirrors a `<dl>` of {@link DetailRow} — the shape of every detail pane. */
export function SkeletonDetailRows({ rows = 6 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex flex-wrap gap-x-4 gap-y-0.5 border-b border-slate-100 py-2 last:border-b-0"
        >
          <div className="w-48 shrink-0">
            <Skeleton width="70%" height="0.75rem" />
          </div>
          <div className="min-w-0 flex-1">
            <Skeleton width={SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]} height="0.875rem" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Mirrors {@link Field} wrapped around a control of {@link Input} height. */
export function SkeletonFields({ count = 4 }: { count?: number }) {
  return (
    <div className="space-y-5">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton width="8rem" height="0.875rem" />
          <Skeleton height="2.375rem" />
        </div>
      ))}
    </div>
  );
}

/**
 * In-place busy glyph for a control that has already committed to an action.
 *
 * Decorative on purpose: the button's own label changes and a live region
 * carries the announcement, so exposing the graphic too would say the same
 * thing twice. `motion-safe:` leaves a static ring for anyone who asked the OS
 * for less movement — the label is what carries the meaning either way.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={cx('size-3.5 shrink-0 motion-safe:animate-spin', className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="2.5"
      />
      <path
        d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------- pagination */

export function Pagination({
  page,
  pageCount: total,
  totalRows,
  hrefFor,
}: {
  page: number;
  pageCount: number;
  totalRows: number;
  hrefFor: (page: number) => string;
}) {
  if (totalRows === 0) return null;

  return (
    <nav
      aria-label="Pagination"
      className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm"
    >
      <p className="text-slate-600">
        Page <span className="font-medium tabular-nums">{page}</span> of{' '}
        <span className="font-medium tabular-nums">{total}</span>
        <span className="px-1.5 text-slate-300" aria-hidden="true">
          |
        </span>
        <span className="tabular-nums">{totalRows.toLocaleString('en-IN')}</span> record
        {totalRows === 1 ? '' : 's'}
      </p>

      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className={buttonClass('secondary', 'px-2.5 py-1.5')}>
            Previous
          </Link>
        ) : (
          <span className={cx(buttonClass('secondary', 'px-2.5 py-1.5'), 'opacity-50')} aria-disabled>
            Previous
          </span>
        )}
        {page < total ? (
          <Link href={hrefFor(page + 1)} className={buttonClass('secondary', 'px-2.5 py-1.5')}>
            Next
          </Link>
        ) : (
          <span className={cx(buttonClass('secondary', 'px-2.5 py-1.5'), 'opacity-50')} aria-disabled>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
