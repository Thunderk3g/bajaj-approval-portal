import { date, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { periodStatusEnum } from './enums';
import { user } from './auth';

/**
 * A reconciliation cycle — 2026-07-28 spec section 4.
 *
 * One calendar month, not a rolling 30-day window. A rolling window has no
 * stable boundary, so two reports run a day apart cover different data and
 * "which month does this gap belong to" has no answer. A monthly tracker that
 * cannot reconcile against last month's copy of itself is not a tracker.
 *
 * Exactly one row may be OPEN at a time. That is enforced by a partial unique
 * index in `drizzle/custom/0005_periods.sql` rather than by
 * application code, so "which period are we in?" has one answer no matter which
 * path asks — and two admins closing and opening concurrently cannot produce
 * two current months.
 */
export const period = pgTable(
  'period',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * `YYYY-MM`. Sortable as text, which is why it is not `MMM-YYYY`: the code
     * is what orders the period list and bounds "older than this one" during an
     * auto-close, and a month-name form would order April before January.
     */
    code: text('code').notNull().unique(),
    /**
     * Stored rather than derived from `code` at render time. An export carries
     * the same words the screen showed; deriving it would put a formatter — and
     * therefore a locale and a timezone — between the two.
     */
    label: text('label').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: periodStatusEnum('status').notNull().default('OPEN'),
    closedBy: text('closed_by').references(() => user.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /**
     * Null when the period was created automatically by an upload rather than
     * opened by hand — which is the normal path, since committing next month's
     * file is what starts next month.
     */
    openedBy: text('opened_by').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('period_status_idx').on(t.status)],
);
