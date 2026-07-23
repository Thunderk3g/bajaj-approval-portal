import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    // RESTRICT, not SET NULL. Spec section 4.2: users are never hard-deleted —
    // deactivation sets is_active = false. SET NULL was unreachable anyway: the
    // FK issues an UPDATE on audit_log, which the append-only trigger rejects,
    // so deleting any audited user failed outright. Enforcing the no-delete rule
    // here is better than widening the immutability trigger to permit it.
    // actorEmail and actorRole remain plain copies so the row stays readable
    // even if the user record is later renamed or re-roled.
    actorId: text('actor_id').references(() => user.id, { onDelete: 'restrict' }),
    actorEmail: text('actor_email'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_action_idx').on(t.action, t.createdAt),
    index('audit_log_entity_idx').on(t.entityType, t.entityId),
    index('audit_log_actor_idx').on(t.actorId, t.createdAt),
  ],
);

export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    link: text('link'),
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notification_user_idx').on(t.userId, t.isRead, t.createdAt)],
);

export const excelExport = pgTable('excel_export', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestedBy: text('requested_by')
    .notNull()
    .references(() => user.id),
  fileName: text('file_name').notNull(),
  storedPath: text('stored_path').notNull(),
  sha256: text('sha256').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  correctionCount: integer('correction_count').notNull().default(0),
  filters: jsonb('filters'),
  downloadCount: integer('download_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
