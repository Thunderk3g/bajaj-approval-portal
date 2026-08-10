import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { roleEnum } from './enums';

export const user = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    role: roleEnum('role').notNull().default('sales'),
    smId: text('sm_id'),
    /**
     * The roster code this manager's authority comes from — 2026-08-06 spec §3.
     *
     * Two columns rather than one shared "org code", and not an overload of
     * `sm_id`: that column is read by name in `scopedRecordCondition` and in
     * every admin query as "this is a rep's own book". Carrying a TL's code in
     * it would make each of those call sites ambiguous about which role it is
     * scoping — six lines of schema against a whole class of silent mis-scope.
     *
     * `acm_code` matches `manpower.ccm_id`, not a column of its own: ACM and CCM
     * are the same rung under a different name (spec §2), so there is one code
     * and one resolver behind both labels.
     */
    tlCode: text('tl_code'),
    acmCode: text('acm_code'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A sales user without an SM_ID cannot be scoped to any records. Enforced
    // here so no application path can create one.
    check('user_sales_requires_sm_id', sql`${t.role} <> 'sales' OR ${t.smId} IS NOT NULL`),
    // The source workbook contains six reps whose SM_ID appears in both cases.
    // Storing either form would split a rep's book in half.
    check('user_sm_id_uppercase', sql`${t.smId} IS NULL OR ${t.smId} = upper(${t.smId})`),
    /**
     * The same pair of guarantees for the two manager rungs. A TL with no code
     * resolves as nobody's approver, so the chain silently skips their stage —
     * the failure the sales check above exists to prevent, one rung up.
     *
     * `role::text`, not a bare `role`, and the cast is load-bearing. These
     * constraints ship in the same migration that adds `tl` and `acm` to the enum,
     * and Postgres refuses to evaluate a newly-added enum value in the
     * transaction that added it — `unsafe use of new value "tl" of enum type
     * role`, which fails the whole migration. Comparing as text never mentions
     * the enum literal, so the constraint is created against values that are not
     * yet committed. The check above keeps its bare comparison because 'sales'
     * has existed since the first migration.
     */
    check('user_tl_requires_tl_code', sql`${t.role}::text <> 'tl' OR ${t.tlCode} IS NOT NULL`),
    check('user_acm_requires_acm_code', sql`${t.role}::text <> 'acm' OR ${t.acmCode} IS NOT NULL`),
    check('user_tl_code_uppercase', sql`${t.tlCode} IS NULL OR ${t.tlCode} = upper(${t.tlCode})`),
    check(
      'user_acm_code_uppercase',
      sql`${t.acmCode} IS NULL OR ${t.acmCode} = upper(${t.acmCode})`,
    ),
    index('user_sm_id_idx').on(t.smId),
    // Both are looked up per stage entry — resolveApprover keys on exactly these.
    index('user_tl_code_idx').on(t.tlCode),
    index('user_acm_code_idx').on(t.acmCode),
  ],
);

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (t) => [index('session_user_id_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('account_user_id_idx').on(t.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);
