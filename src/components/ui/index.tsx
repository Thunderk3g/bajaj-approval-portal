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
    // 19px, not 24px. The design keeps the page title only a step above body
    // text: on a screen that is mostly table, a large heading pushes the first
    // row below the fold and buys nothing.
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">
          {title}
        </h1>
        {description ? (
          <div className="mt-[5px] max-w-3xl text-[13px] text-pretty text-slate-600">
            {description}
          </div>
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
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 px-3.5 py-[9px]">
          <div className="min-w-0">
            {title ? (
              <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className="px-3.5 py-3">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- steps */

export type StepState = 'done' | 'current' | 'todo' | 'blocked';

const STEP_CHIP: Record<StepState, string> = {
  done: 'border-slate-900 bg-slate-900 text-white',
  current: 'border-slate-900 bg-white text-slate-900',
  todo: 'border-slate-300 bg-white text-slate-400',
  blocked: 'border-amber-400 bg-amber-50 text-amber-700',
};

const STEP_LABEL: Record<StepState, string> = {
  done: 'text-slate-500',
  current: 'font-semibold text-slate-900',
  todo: 'text-slate-400',
  blocked: 'font-semibold text-amber-800',
};

function StepGlyph({ state, index }: { state: StepState; index: number }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums',
        STEP_CHIP[state],
      )}
    >
      {state === 'done' ? (
        <svg viewBox="0 0 12 12" className="size-2.5" fill="none">
          <path
            d="M2.5 6.2 4.8 8.5 9.5 3.8"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : state === 'blocked' ? (
        '!'
      ) : (
        index
      )}
    </span>
  );
}

/**
 * The spine of a multi-step screen.
 *
 * Every step in the import is a card somewhere down a long page, and until this
 * existed the only way to answer "how much of this is left" was to scroll to the
 * bottom and count. The chips carry the same numbers as the cards, so a glance
 * at the rail and a glance at a card heading agree.
 *
 * A list, not a nav: these are not links. Steps become reachable by doing the
 * previous one, and a chip you can click to a step the batch is not at yet would
 * be a promise the pipeline cannot keep.
 */
export function Steps({
  steps,
  className,
}: {
  steps: Array<{ label: string; state: StepState }>;
  className?: string;
}) {
  return (
    <ol
      className={cx(
        'flex flex-wrap items-center gap-y-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5',
        className,
      )}
    >
      {steps.map((step, index) => (
        <li
          key={step.label}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className="flex min-w-0 items-center gap-1.5"
        >
          <StepGlyph state={step.state} index={index + 1} />
          <span className={cx('truncate text-[11px]', STEP_LABEL[step.state])}>{step.label}</span>
          {/* A hairline between chips rather than a full-width rail: the steps
              wrap on a narrow viewport, and a connector that stretches leaves a
              rule dangling off the end of every wrapped row. */}
          {index < steps.length - 1 ? (
            <span aria-hidden="true" className="mx-2 h-px w-4 shrink-0 bg-slate-200 sm:w-7" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * A {@link Card} that knows where it sits in a sequence — and folds once passed.
 *
 * `<details>`, not client state: the open/closed decision is made on the server
 * from the batch's own status, it survives a refresh for free, and a step that
 * is finished should not be shipping a state hook to the browser to say so.
 *
 * Done steps close. That is the whole point — a validated batch used to put a
 * twenty-row mapping table and a sheet picker between the admin and the commit
 * button, so the one action left on the screen was the one below the fold.
 */
export function StepCard({
  step,
  title,
  description,
  state,
  status,
  children,
}: {
  step: number;
  title: ReactNode;
  description?: ReactNode;
  state: StepState;
  /** Short right-aligned summary of the outcome — shown even when folded. */
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <details
      open={state !== 'done'}
      className={cx(
        'group rounded-lg border bg-white',
        state === 'current'
          ? 'border-slate-300 shadow-[0_1px_2px_rgba(15,23,42,0.06)]'
          : 'border-slate-200',
      )}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-t-lg px-3.5 py-[9px] marker:content-none hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-slate-500">
        <StepGlyph state={state} index={step} />
        <div className="min-w-0 flex-1">
          <h2
            className={cx(
              'text-[13px] font-semibold',
              state === 'todo' ? 'text-slate-500' : 'text-slate-900',
            )}
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{description}</p>
          ) : null}
        </div>
        {status ? <div className="flex shrink-0 items-center gap-2">{status}</div> : null}
        {/* The only affordance saying this panel opens. Rotates rather than
            swapping glyphs so the control stays in one place while it turns. */}
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="size-3 shrink-0 text-slate-400 transition-transform group-open:rotate-90"
          fill="none"
        >
          <path
            d="m4.5 2.5 4 3.5-4 3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="border-t border-slate-200 px-3.5 py-3">{children}</div>
    </details>
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
      {/* 10px uppercase over a 25px number: the label names the figure, it is
          not competing with it. Same treatment as a column header. */}
      <p className="text-[10px] font-semibold uppercase tracking-[0.07em] text-slate-500">
        {label}
      </p>
      <p
        className={cx(
          'mt-1 text-[25px] leading-tight font-semibold tracking-[-0.02em] tabular-nums',
          tones[tone],
        )}
      >
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-slate-500">{hint}</p> : null}
    </>
  );

  const className =
    'block rounded-lg border border-slate-200 bg-white px-3.5 py-3 no-underline' +
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
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-11 text-center">
      <p className="text-[13px] font-medium text-slate-700">{title}</p>
      {description ? (
        // Capped and centred: an explanation of why a queue is empty runs to a
        // sentence or two, and centred text set the full width of a 1500px
        // canvas is unreadable.
        <p className="mx-auto mt-1.5 max-w-[52ch] text-[13px] text-pretty text-slate-500">
          {description}
        </p>
      ) : null}
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
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-800',
    danger: 'border-red-200 bg-red-50 text-red-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  } as const;

  // The heading sits one step darker than the body it introduces, which is what
  // separates the two lines without a second type size or a rule between them.
  const headings = {
    info: 'text-sky-900',
    warning: 'text-amber-900',
    danger: 'text-red-900',
    success: 'text-emerald-900',
  } as const;

  return (
    <div className={cx('rounded-lg border px-3.5 py-3 text-[13px]', tones[tone])} role="alert">
      {title ? <p className={cx('font-semibold', headings[tone])}>{title}</p> : null}
      {children ? (
        <div className={cx('text-pretty', title ? 'mt-[5px]' : null)}>{children}</div>
      ) : null}
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
    // A small rounded rectangle, not a pill. Badges sit inside table cells
    // beside monospaced codes, and a fully rounded capsule reads as a button
    // somebody can press.
    <span
      className={cx(
        'inline-flex items-center rounded border px-1.5 py-px text-[11px] font-medium whitespace-nowrap',
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
      <table className="w-full min-w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className, ...rest }: ComponentProps<'th'>) {
  return (
    // 10px uppercase with wide tracking. The header is a label for the column,
    // not content: shrinking it is what lets the rows below stay the thing the
    // eye lands on.
    <th
      scope="col"
      className={cx(
        'border-b border-slate-200 bg-slate-50 px-2.5 py-[7px] text-left text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-600 whitespace-nowrap',
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
    <td
      className={cx(
        'border-b border-slate-100 px-2.5 py-[9px] align-top text-slate-800',
        className,
      )}
      {...rest}
    >
      {children}
    </td>
  );
}

/** Definition row for detail panes — label left, value right. */
export function DetailRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-slate-100 py-1.5 last:border-b-0">
      {/* 112px, not 192px: these panes are laid out two columns to a card, and a
          label rail wide enough for the longest field name in the system leaves
          the value it describes with nowhere to go. */}
      <dt className="w-28 shrink-0 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-500">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[13px] text-slate-900">{children}</dd>
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

const CONTROL =
  'w-full rounded-md border border-slate-300 bg-white px-2.5 py-[7px] text-[13px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-500 focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-500';

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
      <label htmlFor={htmlFor} className="block text-[13px] font-medium text-slate-700">
        {label}
        {required ? (
          <span className="ml-0.5 text-red-700" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint ? <p className="text-[11px] text-slate-500">{hint}</p> : null}
      {messages.map((m) => (
        <p key={m} className="text-[12px] text-red-700">
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
  return <textarea className={cx(CONTROL, 'min-h-[82px] resize-y py-2', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: ComponentProps<'select'>) {
  return (
    <select className={cx(CONTROL, className)} {...rest}>
      {children}
    </select>
  );
}

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

// 12px on a 29px-high control. The design's buttons sit inline with table rows
// and filter bars, so a 40px default-height button would set the rhythm of every
// toolbar it appears in.
//
// The border is in the base, not the variants: a filled button without one and
// an outlined button with one differ by 2px of height, which is visible the
// moment they sit side by side in a toolbar — as they always do.
const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md border px-[11px] py-1.5 text-[12px] font-medium no-underline transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-60';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'border-slate-900 bg-slate-900 text-white hover:border-slate-800 hover:bg-slate-800 focus:ring-slate-500',
  secondary: 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-400',
  danger: 'border-red-700 bg-red-700 text-white hover:border-red-800 hover:bg-red-800 focus:ring-red-500',
  ghost: 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900 focus:ring-slate-400',
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
      className={cx('block rounded-[3px] bg-slate-200 motion-safe:animate-pulse', className)}
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

/** Mirrors {@link PageHeader}, down to its `mb-4`, so nothing shifts on swap. */
export function SkeletonPageHeader({ actions = 0 }: { actions?: number }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <Skeleton width="17.5rem" height="1.625rem" className="max-w-full" />
        <Skeleton width="26rem" height="0.8125rem" className="mt-[9px] max-w-full" />
      </div>
      {actions > 0 ? (
        <div className="flex shrink-0 items-center gap-2">
          {Array.from({ length: actions }, (_, i) => (
            <Skeleton key={i} width="6.5rem" height="1.8125rem" />
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
        <div key={i} className="rounded-lg border border-slate-200 bg-white px-3.5 py-3">
          <Skeleton width="45%" height="0.625rem" />
          <Skeleton width="30%" height="1.9375rem" className="mt-1" />
          <Skeleton width="60%" height="0.6875rem" className="mt-1" />
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
          className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-slate-100 py-1.5 last:border-b-0"
        >
          <div className="w-28 shrink-0 pt-0.5">
            <Skeleton width="80%" height="0.625rem" />
          </div>
          <div className="min-w-0 flex-1">
            <Skeleton width={SKELETON_WIDTHS[i % SKELETON_WIDTHS.length]} height="0.8125rem" />
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
          <Skeleton width="8rem" height="0.8125rem" />
          <Skeleton height="2.0625rem" />
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

  const step = 'px-2.5 py-1';
  // Spelled out rather than `buttonClass(...) + 'opacity-50'`: two border-colour
  // utilities on one element leave which wins to stylesheet order, and a washed
  // -out copy of an enabled control reads as "loading", not "there is no page
  // before this one".
  const exhausted =
    'inline-flex items-center justify-center rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-400';

  return (
    <nav
      aria-label="Pagination"
      className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[12px] text-slate-600"
    >
      <p>
        Page <span className="font-semibold tabular-nums">{page}</span> of{' '}
        <span className="font-semibold tabular-nums">{total}</span>
        <span className="px-1.5 text-slate-300" aria-hidden="true">
          |
        </span>
        <span className="tabular-nums">{totalRows.toLocaleString('en-IN')}</span> record
        {totalRows === 1 ? '' : 's'}
      </p>

      <div className="flex items-center gap-1.5">
        {page > 1 ? (
          <Link href={hrefFor(page - 1)} className={buttonClass('secondary', step)}>
            Previous
          </Link>
        ) : (
          <span className={exhausted} aria-disabled>
            Previous
          </span>
        )}
        {page < total ? (
          <Link href={hrefFor(page + 1)} className={buttonClass('secondary', step)}>
            Next
          </Link>
        ) : (
          <span className={exhausted} aria-disabled>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}
