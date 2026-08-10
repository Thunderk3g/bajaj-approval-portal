import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { chainKeyEnum, stageStatusEnum } from './enums';
import { user } from './auth';
import { correctionRequest } from './corrections';

/**
 * The configurable approval chain — 2026-08-06 spec sections 3 and 4.
 *
 * Replaces the hardcoded verifier → approver pair with an ordered list of stages
 * an admin can edit. Two tables define a chain and a third materialises it per
 * request; the split is what makes an admin edit safe while work is in flight
 * (see `correctionRequestStage`).
 *
 * A DAG was considered and rejected. Nothing in the requirement branches WITHIN a
 * chain — between-team mapping looks like a fork but is really "which linear
 * chain gets chosen at submission", a routing decision — and a graph model would
 * force the admin screen, the queue and the timeline to reason about paths where
 * a position is enough. Fixed `stage1By/stage2By/...` columns were rejected for
 * the opposite reason: BAU-to-BFL already needs five stages, and a sixth next
 * quarter would be a migration rather than a row.
 */

export const approvalChain = pgTable('approval_chain', {
  id: uuid('id').primaryKey().defaultRandom(),
  chainKey: chainKeyEnum('chain_key').notNull().unique(),
  label: text('label').notNull(),
  /**
   * False blocks NEW submissions onto this chain and nothing else. Requests
   * already running it keep going — they hold their own copy of the stages and
   * never read this table again.
   */
  isActive: boolean('is_active').notNull().default(true),
  updatedBy: text('updated_by').references(() => user.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const approvalChainStage = pgTable(
  'approval_chain_stage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chainId: uuid('chain_id')
      .notNull()
      .references(() => approvalChain.id, { onDelete: 'cascade' }),
    /** 0-based. Reordering rewrites this column; see `setChainStages`. */
    sequence: integer('sequence').notNull(),
    /** What the admin screen and the timeline call this rung: 'TL', 'ACM', 'V2'. */
    stageKey: text('stage_key').notNull(),
    /**
     * Which registered resolver answers "who may act here" — 'ROLE', 'TL_OF_SM',
     * 'ACM_OF_SM'. Text rather than an enum because the set grows as the
     * hierarchy module registers more, and a schema migration per new resolver
     * would put the engine back in the business of knowing its callers.
     */
    resolverKey: text('resolver_key').notNull(),
    /** Parameters for that resolver, e.g. `{ role: 'verifier' }`, `{ smSide: 'COUNTERPARTY' }`. */
    resolverConfig: jsonb('resolver_config').$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Mirrors today's asymmetry, where a verifier may return but only an approver
     * may reject. Default false on every rung; the admin sets it, and the seeded
     * chains set it on the final stage only.
     */
    canReject: boolean('can_reject').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('approval_chain_stage_unique').on(t.chainId, t.sequence)],
);

/**
 * One request's own copy of one rung — the snapshot that makes admin edits safe.
 *
 * Every column between `stageKey` and `canReject` is COPIED from
 * `approval_chain_stage` when the request is submitted, and nothing ever re-reads
 * the definition afterwards. An admin adding, removing or reordering a stage
 * therefore cannot strand a request that is already moving: it finishes on the
 * chain it started, and the edit applies from the next submission onward.
 *
 * This is the same discipline `correction_request.period_id` already follows —
 * stamped once, never recomputed — and it is why no chain-version table exists.
 * A version pointer would buy the identical guarantee at the cost of a second
 * table, a version bump on every edit, and a join on every read.
 */
export const correctionRequestStage = pgTable(
  'correction_request_stage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => correctionRequest.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),

    /* ---- copied from approval_chain_stage at submission, never re-read ---- */
    stageKey: text('stage_key').notNull(),
    resolverKey: text('resolver_key').notNull(),
    resolverConfig: jsonb('resolver_config').$type<Record<string, unknown>>().notNull(),
    canReject: boolean('can_reject').notNull(),

    status: stageStatusEnum('status').notNull().default('PENDING'),
    decidedBy: text('decided_by').references(() => user.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    remarks: text('remarks'),
    /**
     * Who this rung resolved to when it became ACTIVE, for a hierarchy stage.
     *
     * Pinned at stage entry rather than re-resolved on every decision: a rep
     * reassigned to a new TL mid-review must not silently move a request somebody
     * has already opened, and the person asked to act should be a named,
     * auditable individual rather than a live join that can answer differently
     * between the moment they see the queue and the moment they click. Null for
     * role-pool stages, where the pool IS the answer.
     */
    assignedUserId: text('assigned_user_id').references(() => user.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('correction_request_stage_unique').on(t.requestId, t.sequence),
    /**
     * THE guarantee, in the same shape as `correction_one_open_per_field`: the
     * index is what makes "one active stage per request" true, and the FOR UPDATE
     * read in `decideStageWithin` is the explanation. Two verifiers deciding the
     * same rung concurrently is otherwise a lost update, not an error.
     */
    uniqueIndex('correction_request_stage_one_active')
      .on(t.requestId)
      .where(sql`status = 'ACTIVE'`),
    index('correction_request_stage_request_idx').on(t.requestId, t.sequence),
    // The queue reads "stages waiting on me": ACTIVE, resolved to this user.
    index('correction_request_stage_assignee_idx').on(t.assignedUserId, t.status),
  ],
);
