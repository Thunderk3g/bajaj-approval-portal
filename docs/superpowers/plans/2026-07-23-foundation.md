# Sales Disposition Reconciliation Portal — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a Next.js + PostgreSQL application in which a user can log in and reach a role-appropriate dashboard, backed by the complete database schema, enforced RBAC, and an append-only audit log.

**Architecture:** Next.js App Router with Server Actions for mutations. Better Auth owns sessions with database-backed lookups so role changes take effect immediately. Drizzle owns the schema; business invariants that matter (sales users must have an `SM_ID`, "Others" corrections must carry a description, one open correction per field, audit rows are immutable) are enforced by database constraints and triggers, not only by application code. Authorization lives in a small set of helpers that every action calls — middleware only redirects.

**Tech Stack:** Next.js 15 (App Router, TypeScript), Better Auth, PostgreSQL 16 (Docker), Drizzle ORM + drizzle-kit, Zod, Tailwind CSS v4, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-23-sales-disposition-reconciliation-portal-design.md`

## Global Constraints

- **Node 20.15.1** is the installed runtime. Do not use APIs newer than Node 20.
- **Money is `numeric(18,2)`.** Never `real`, `double precision`, or JS `number` for `fp` / `anp`. Read them from Postgres as strings.
- **`apps_no` and `policy_no` are `text`**, never numeric — they are identifiers, not operands.
- **`sm_id` is always stored uppercased.** Normalize on every write and every comparison.
- **Authorization is never enforced by middleware alone.** Every Server Action and Route Handler calls `requireRole` or `requireSession` itself.
- **Sales-scoped reads always go through `scopedRecordCondition`.** No hand-written `sm_id` filters in page code.
- **`audit_log` is append-only.** Enforced by a database trigger; no application code may update or delete it.
- **No public sign-up.** `emailAndPassword.disableSignUp = true`.
- All timestamps are `timestamp with time zone`.
- Commit after every task. Conventional-commit prefixes (`feat:`, `test:`, `chore:`).

---

## File Structure

```
docker-compose.yml               Postgres 16 + a test database
drizzle.config.ts                drizzle-kit config
vitest.config.ts                 Vitest config, node environment
.env.example / .env.local        DATABASE_URL, DATABASE_URL_TEST, BETTER_AUTH_SECRET, BETTER_AUTH_URL

src/db/
  client.ts                      Pool + drizzle instance (singleton)
  schema/
    enums.ts                     All pgEnum definitions
    auth.ts                      user, session, account, verification
    records.ts                   upload_batch, upload_batch_row, sales_record, sales_record_version
    corrections.ts               correction_request, correction_attachment, correction_event
    system.ts                    audit_log, notification, excel_export
    index.ts                     Re-exports everything (drizzle-kit entry point)

src/lib/
  auth/
    server.ts                    Better Auth instance
    client.ts                    Better Auth React client
    rbac.ts                      requireSession, requireRole, scopedRecordCondition
    errors.ts                    AuthzError
  audit/
    log.ts                       writeAudit()
    actions.ts                   AuditAction union type
  env.ts                         Zod-validated environment variables

src/app/
  layout.tsx                     Root layout
  page.tsx                       Redirects to role dashboard or /login
  login/page.tsx                 Login form
  admin/layout.tsx  admin/page.tsx
  sales/layout.tsx  sales/page.tsx
  approver/layout.tsx  approver/page.tsx
  api/auth/[...all]/route.ts     Better Auth handler
  api/health/route.ts            DB connectivity probe

src/components/
  app-shell.tsx                  Sidebar + header, role-aware nav
  login-form.tsx                 Client component

src/middleware.ts                Route-level redirects (not the authz boundary)
scripts/setup-admin.ts           Interactive first-admin creation

tests/
  setup.ts                       Loads .env.local, points at DATABASE_URL_TEST
  helpers/db.ts                  truncateAll(), makeUser()
  db/constraints.test.ts         Database invariants
  lib/rbac.test.ts               Authorization helpers
  lib/audit.test.ts              Audit log behaviour
```

---

## Task 1: Scaffold, Postgres, and a health check

**Files:**
- Create: `docker-compose.yml`, `.env.example`, `.env.local`, `drizzle.config.ts`, `vitest.config.ts`
- Create: `src/lib/env.ts`, `src/db/client.ts`, `src/app/api/health/route.ts`
- Create: `tests/setup.ts`, `tests/db/connection.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `db` (Drizzle instance) and `pool` (pg Pool) from `src/db/client.ts`; `env` object from `src/lib/env.ts` with `DATABASE_URL`, `DATABASE_URL_TEST`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`

- [ ] **Step 1: Scaffold the Next.js app**

Run from the repository root (the directory already contains `docs/` and `.git`):

```bash
npx --yes create-next-app@15 . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --no-turbopack
```

Answer `yes` if it asks to proceed in a non-empty directory. It will not touch `docs/` or `.git`.

- [ ] **Step 2: Install dependencies**

```bash
npm install drizzle-orm pg better-auth zod
npm install --save-dev drizzle-kit @types/pg vitest dotenv tsx
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: sdrp-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: sdrp
      POSTGRES_PASSWORD: sdrp_local_dev
      POSTGRES_DB: sdrp
    ports:
      - "5432:5432"
    volumes:
      - sdrp-pgdata:/var/lib/postgresql/data
      - ./docker/init:/docker-entrypoint-initdb.d
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sdrp -d sdrp"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  sdrp-pgdata:
```

- [ ] **Step 4: Create the init script that adds the test database and extensions**

Create `docker/init/01-init.sql`:

```sql
CREATE DATABASE sdrp_test OWNER sdrp;

\connect sdrp
CREATE EXTENSION IF NOT EXISTS pg_trgm;

\connect sdrp_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

`pg_trgm` backs the substring search required by spec §9.1. It must exist in both databases so integration tests exercise the same indexes as production.

- [ ] **Step 5: Start Postgres and verify it is healthy**

```bash
docker compose up -d
docker compose ps
```

Expected: `sdrp-postgres` listed with status `Up` and `(healthy)`. If it says `starting`, wait 10 seconds and re-run `docker compose ps`.

- [ ] **Step 6: Create `.env.example` and `.env.local`**

`.env.example`:

```
DATABASE_URL=postgresql://sdrp:sdrp_local_dev@localhost:5432/sdrp
DATABASE_URL_TEST=postgresql://sdrp:sdrp_local_dev@localhost:5432/sdrp_test
BETTER_AUTH_SECRET=replace-me-with-32-plus-random-chars
BETTER_AUTH_URL=http://localhost:3000
```

Copy it to `.env.local` and replace the secret with real random bytes:

```bash
cp .env.example .env.local
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste that value as `BETTER_AUTH_SECRET` in `.env.local`.

- [ ] **Step 7: Confirm `.env.local` is git-ignored**

```bash
git check-ignore -v .env.local
```

Expected: a line showing `.gitignore` matched it. If the command prints nothing, add `.env.local` to `.gitignore` before continuing — this file holds the session-signing secret.

- [ ] **Step 8: Create `src/lib/env.ts`**

```ts
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  DATABASE_URL_TEST: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 characters'),
  BETTER_AUTH_URL: z.string().url(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const env = parsed.data;
```

Failing fast on a short secret is deliberate: a weak `BETTER_AUTH_SECRET` silently weakens every session cookie, and that is not something to discover in production.

- [ ] **Step 9: Create `src/db/client.ts`**

```ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const connectionString =
  process.env.NODE_ENV === 'test'
    ? process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!
    : process.env.DATABASE_URL!;

const globalForDb = globalThis as unknown as { __sdrpPool?: Pool };

const isDev = process.env.NODE_ENV === 'development';

export const pool = (isDev && globalForDb.__sdrpPool) || new Pool({ connectionString, max: 10 });

if (isDev) globalForDb.__sdrpPool = pool;

export const db = drizzle(pool, { schema });
```

The `globalThis` cache prevents Next.js hot reload from opening a new pool on every edit and exhausting Postgres connections. It is **scoped to development only, deliberately**: every test file calls `pool.end()` in `afterAll`, and if the pool were shared across files through `globalThis`, the second file to run would inherit a closed pool and fail with `Cannot use a pool after calling end`. Caching only in development avoids that entirely.

- [ ] **Step 10: Create a placeholder schema barrel so the client compiles**

Create `src/db/schema/index.ts`:

```ts
export {};
```

Task 2 replaces this with real exports.

- [ ] **Step 11: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

`fileParallelism: false` matters: these tests share one database and truncate tables between runs. Parallel files would race.

- [ ] **Step 12: Create `tests/setup.ts`**

```ts
import { config } from 'dotenv';

config({ path: '.env.local' });

process.env.NODE_ENV = 'test';

if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set — tests must never run against the dev database');
}
```

The guard is the point. A test suite that truncates tables must not be one typo away from pointing at real data.

- [ ] **Step 13: Add scripts to `package.json`**

Merge into the existing `"scripts"` block:

```json
"scripts": {
  "dev": "next dev",
  "build": "next build",
  "start": "next start",
  "lint": "next lint",
  "test": "vitest run",
  "test:watch": "vitest",
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:studio": "drizzle-kit studio",
  "setup:admin": "tsx scripts/setup-admin.ts"
}
```

- [ ] **Step 14: Create `drizzle.config.ts`**

```ts
import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: '.env.local' });

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  verbose: true,
  strict: true,
});
```

- [ ] **Step 15: Write the failing connection test**

Create `tests/db/connection.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';

describe('database connection', () => {
  afterAll(async () => {
    await pool.end();
  });

  it('connects to the test database', async () => {
    const result = await db.execute(sql`select current_database() as name`);
    expect(result.rows[0].name).toBe('sdrp_test');
  });

  it('has the pg_trgm extension available', async () => {
    const result = await db.execute(
      sql`select extname from pg_extension where extname = 'pg_trgm'`,
    );
    expect(result.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 16: Run the test to verify it passes**

```bash
npm test -- tests/db/connection.test.ts
```

Expected: 2 passed. If `pg_trgm` is missing, the init script did not run — the volume was created before `docker/init` existed. Fix with `docker compose down -v && docker compose up -d`, which destroys and recreates the volume.

- [ ] **Step 17: Create the health route**

Create `src/app/api/health/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: 'ok', database: 'up' });
  } catch {
    return NextResponse.json({ status: 'degraded', database: 'down' }, { status: 503 });
  }
}
```

The catch deliberately swallows the error detail. A health endpoint that echoes connection strings or driver stack traces to an unauthenticated caller is an information leak.

- [ ] **Step 18: Verify the app boots and the health check passes**

```bash
npm run dev
```

In a second terminal:

```bash
curl -s http://localhost:3000/api/health
```

Expected: `{"status":"ok","database":"up"}`. Stop the dev server afterwards.

- [ ] **Step 19: Commit**

```bash
git add -A
git commit -m "feat: scaffold Next.js app with Postgres, Drizzle, and health check"
```

---

## Task 2: Enums and authentication schema

**Files:**
- Create: `src/db/schema/enums.ts`, `src/db/schema/auth.ts`
- Modify: `src/db/schema/index.ts`
- Create: `tests/helpers/db.ts`, `tests/db/auth-schema.test.ts`

**Interfaces:**
- Consumes: `db`, `pool` from `src/db/client.ts`
- Produces: `roleEnum`, `correctionStatusEnum`, `correctionCategoryEnum`, `batchStatusEnum`, `changeTypeEnum`, `eventActionEnum`, `rowStatusEnum` from `enums.ts`; `user`, `session`, `account`, `verification` tables from `auth.ts`; `truncateAll()` and `makeUser(overrides)` from `tests/helpers/db.ts`

- [ ] **Step 1: Create `src/db/schema/enums.ts`**

```ts
import { pgEnum } from 'drizzle-orm/pg-core';

export const roleEnum = pgEnum('role', ['admin', 'sales', 'approver']);

export const correctionStatusEnum = pgEnum('correction_status', [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'RETURNED',
]);

export const correctionCategoryEnum = pgEnum('correction_category', [
  'AUTOPAY',
  'MAPPING',
  'ISSUANCE_DATE',
  'OTHERS',
]);

export const batchStatusEnum = pgEnum('batch_status', [
  'DRAFT',
  'MAPPED',
  'VALIDATED',
  'COMMITTED',
  'FAILED',
  'ABORTED',
]);

export const changeTypeEnum = pgEnum('change_type', [
  'IMPORT',
  'CORRECTION',
  'REIMPORT',
  'ADMIN_EDIT',
]);

export const eventActionEnum = pgEnum('event_action', [
  'SUBMITTED',
  'RESUBMITTED',
  'APPROVED',
  'REJECTED',
  'RETURNED',
  'WITHDRAWN',
]);

export const rowStatusEnum = pgEnum('row_status', [
  'VALID',
  'INVALID',
  'DUPLICATE',
  'COMMITTED',
  'SKIPPED',
]);
```

- [ ] **Step 2: Create `src/db/schema/auth.ts`**

```ts
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
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_sales_requires_sm_id', sql`${t.role} <> 'sales' OR ${t.smId} IS NOT NULL`),
    check('user_sm_id_uppercase', sql`${t.smId} IS NULL OR ${t.smId} = upper(${t.smId})`),
    index('user_sm_id_idx').on(t.smId),
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
```

The two `CHECK` constraints are the spec's §4.2 rules made unbypassable. A sales user without an `SM_ID` sees nobody's records and cannot be scoped; a lowercase `SM_ID` silently splits a rep's book (spec §6.3 measured six such reps in the real file). Neither should depend on application code remembering.

- [ ] **Step 3: Update `src/db/schema/index.ts`**

```ts
export * from './enums';
export * from './auth';
```

- [ ] **Step 4: Generate and apply the migration**

```bash
npm run db:generate
npm run db:migrate
```

Expected: a file appears under `drizzle/` and the migrate command reports applied migrations.

- [ ] **Step 5: Apply the migration to the test database**

```bash
DATABASE_URL="$DATABASE_URL_TEST" npx drizzle-kit migrate
```

On PowerShell:

```powershell
$env:DATABASE_URL = (Select-String -Path .env.local -Pattern '^DATABASE_URL_TEST=(.*)$').Matches.Groups[1].Value
npx drizzle-kit migrate
```

- [ ] **Step 6: Create `tests/helpers/db.ts`**

```ts
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { user } from '@/db/schema';

export async function truncateAll() {
  await db.execute(sql`
    truncate table "session", "account", "verification", "user" restart identity cascade
  `);
}

type UserOverrides = Partial<{
  name: string;
  email: string;
  role: 'admin' | 'sales' | 'approver';
  smId: string | null;
  isActive: boolean;
}>;

export async function makeUser(overrides: UserOverrides = {}) {
  const id = randomUUID();
  const role = overrides.role ?? 'admin';
  const [row] = await db
    .insert(user)
    .values({
      id,
      name: overrides.name ?? `Test ${role}`,
      email: overrides.email ?? `${id}@example.test`,
      role,
      smId: overrides.smId !== undefined ? overrides.smId : role === 'sales' ? 'C2CM00001' : null,
      isActive: overrides.isActive ?? true,
    })
    .returning();
  return row;
}
```

- [ ] **Step 7: Write the failing schema test**

Create `tests/db/auth-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, pool } from '@/db/client';
import { user } from '@/db/schema';
import { truncateAll, makeUser } from '../helpers/db';

describe('auth schema constraints', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await pool.end();
  });

  it('creates an admin without an SM_ID', async () => {
    const row = await makeUser({ role: 'admin', smId: null });
    expect(row.role).toBe('admin');
    expect(row.smId).toBeNull();
  });

  it('rejects a sales user with no SM_ID', async () => {
    await expect(
      db.insert(user).values({
        id: randomUUID(),
        name: 'No Scope',
        email: 'noscope@example.test',
        role: 'sales',
        smId: null,
      }),
    ).rejects.toThrow(/user_sales_requires_sm_id/);
  });

  it('rejects a lowercase SM_ID', async () => {
    await expect(
      db.insert(user).values({
        id: randomUUID(),
        name: 'Lower Case',
        email: 'lower@example.test',
        role: 'sales',
        smId: 'c2cm21350',
      }),
    ).rejects.toThrow(/user_sm_id_uppercase/);
  });

  it('rejects a duplicate email', async () => {
    await makeUser({ email: 'dupe@example.test' });
    await expect(makeUser({ email: 'dupe@example.test' })).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Run the test**

```bash
npm test -- tests/db/auth-schema.test.ts
```

Expected: 4 passed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add enums and auth schema with SM_ID constraints"
```

---

## Task 3: Domain schema

**Files:**
- Create: `src/db/schema/records.ts`, `src/db/schema/corrections.ts`, `src/db/schema/system.ts`
- Modify: `src/db/schema/index.ts`
- Create: `drizzle/custom/0001_audit_append_only.sql`
- Modify: `tests/helpers/db.ts`
- Create: `tests/db/constraints.test.ts`

**Interfaces:**
- Consumes: enums from `enums.ts`, `user` from `auth.ts`
- Produces: `uploadBatch`, `uploadBatchRow`, `salesRecord`, `salesRecordVersion` from `records.ts`; `correctionRequest`, `correctionAttachment`, `correctionEvent` from `corrections.ts`; `auditLog`, `notification`, `excelExport` from `system.ts`

- [ ] **Step 1: Create `src/db/schema/records.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  boolean, check, date, index, integer, jsonb, numeric, pgTable,
  text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { batchStatusEnum, changeTypeEnum, rowStatusEnum } from './enums';
import { user } from './auth';

export const uploadBatch = pgTable('upload_batch', {
  id: uuid('id').primaryKey().defaultRandom(),
  originalFileName: text('original_file_name').notNull(),
  storedPath: text('stored_path').notNull(),
  fileHash: text('file_hash').notNull(),
  sheetName: text('sheet_name'),
  headerRow: integer('header_row').notNull().default(1),
  dateFormat: text('date_format').notNull().default('dd/MM/yyyy'),
  columnMapping: jsonb('column_mapping').$type<Record<string, string>>(),
  totalRows: integer('total_rows').notNull().default(0),
  validRows: integer('valid_rows').notNull().default(0),
  invalidRows: integer('invalid_rows').notNull().default(0),
  duplicateRows: integer('duplicate_rows').notNull().default(0),
  status: batchStatusEnum('status').notNull().default('DRAFT'),
  validationReport: jsonb('validation_report'),
  notes: text('notes'),
  uploadedBy: text('uploaded_by').notNull().references(() => user.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  committedBy: text('committed_by').references(() => user.id),
  committedAt: timestamp('committed_at', { withTimezone: true }),
}, (t) => [
  index('upload_batch_status_idx').on(t.status),
  index('upload_batch_hash_idx').on(t.fileHash),
]);

export const uploadBatchRow = pgTable('upload_batch_row', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => uploadBatch.id, { onDelete: 'cascade' }),
  rowNumber: integer('row_number').notNull(),
  raw: jsonb('raw').notNull(),
  normalized: jsonb('normalized'),
  issues: jsonb('issues').$type<Array<{ field: string; code: string; severity: string; message: string }>>(),
  isDuplicate: boolean('is_duplicate').notNull().default(false),
  duplicateOfRow: integer('duplicate_of_row'),
  status: rowStatusEnum('status').notNull().default('VALID'),
}, (t) => [
  uniqueIndex('upload_batch_row_unique').on(t.batchId, t.rowNumber),
  index('upload_batch_row_status_idx').on(t.batchId, t.status),
]);

export const salesRecord = pgTable('sales_record', {
  id: uuid('id').primaryKey().defaultRandom(),
  appsNo: text('apps_no').notNull().unique(),
  policyNo: text('policy_no'),
  clientName: text('client_name'),
  leadId: text('lead_id'),
  smId: text('sm_id').notNull(),
  smName: text('sm_name'),
  tlId: text('tl_id'),
  tlName: text('tl_name'),
  ccmId: text('ccm_id'),
  ccmName: text('ccm_name'),
  location: text('location'),
  loginDate: date('login_date'),
  issuedDate: date('issued_date'),
  fp: numeric('fp', { precision: 18, scale: 2 }),
  anp: numeric('anp', { precision: 18, scale: 2 }),
  productName: text('product_name'),
  productType: text('product_type'),
  productVariant: text('product_variant'),
  bookingFrequency: text('booking_frequency'),
  payMode: text('pay_mode'),
  status: text('status'),
  status2: text('status_2'),
  autopay: text('autopay'),
  extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
  sourceBatchId: uuid('source_batch_id').references(() => uploadBatch.id),
  sourceRowNumber: integer('source_row_number'),
  currentVersion: integer('current_version').notNull().default(1),
  hasCorrections: boolean('has_corrections').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check('sales_record_sm_id_uppercase', sql`${t.smId} = upper(${t.smId})`),
  index('sales_record_sm_id_idx').on(t.smId),
  index('sales_record_status_idx').on(t.status),
  index('sales_record_issued_date_idx').on(t.issuedDate),
  index('sales_record_policy_no_idx').on(t.policyNo),
]);

export const salesRecordVersion = pgTable('sales_record_version', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordId: uuid('record_id').notNull().references(() => salesRecord.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  data: jsonb('data').notNull(),
  changeType: changeTypeEnum('change_type').notNull(),
  changedFields: text('changed_fields').array(),
  changedBy: text('changed_by').references(() => user.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
  correctionRequestId: uuid('correction_request_id'),
  batchId: uuid('batch_id').references(() => uploadBatch.id),
  note: text('note'),
}, (t) => [
  uniqueIndex('sales_record_version_unique').on(t.recordId, t.version),
]);
```

- [ ] **Step 2: Add the trigram indexes drizzle-kit cannot express**

Create `drizzle/custom/0000_trigram_indexes.sql`:

```sql
CREATE INDEX IF NOT EXISTS sales_record_apps_no_trgm
  ON sales_record USING gin (apps_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_policy_no_trgm
  ON sales_record USING gin (policy_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_client_name_trgm
  ON sales_record USING gin (client_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_sm_name_trgm
  ON sales_record USING gin (sm_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS sales_record_extra_gin
  ON sales_record USING gin (extra);
```

These back the substring search of spec §9.1. Without them, `ILIKE '%term%'` over 1,171 rows is fine but degrades badly as months accumulate.

- [ ] **Step 3: Create `src/db/schema/corrections.ts`**

```ts
import { sql } from 'drizzle-orm';
import {
  check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { correctionCategoryEnum, correctionStatusEnum, eventActionEnum } from './enums';
import { user } from './auth';
import { salesRecord } from './records';

export const correctionRequest = pgTable('correction_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordId: uuid('record_id').notNull().references(() => salesRecord.id, { onDelete: 'cascade' }),
  appsNo: text('apps_no').notNull(),
  category: correctionCategoryEnum('category').notNull(),
  fieldName: text('field_name').notNull(),
  fieldLabel: text('field_label').notNull(),
  originalValue: text('original_value'),
  proposedValue: text('proposed_value').notNull(),
  description: text('description'),
  submittedBy: text('submitted_by').notNull().references(() => user.id),
  smId: text('sm_id').notNull(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  status: correctionStatusEnum('status').notNull().default('PENDING'),
  reviewedBy: text('reviewed_by').references(() => user.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  approverRemarks: text('approver_remarks'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedVersion: integer('applied_version'),
  resubmissionCount: integer('resubmission_count').notNull().default(0),
  lastResubmittedAt: timestamp('last_resubmitted_at', { withTimezone: true }),
}, (t) => [
  check(
    'correction_others_requires_description',
    sql`${t.category} <> 'OTHERS' OR (${t.description} IS NOT NULL AND length(trim(${t.description})) > 0)`,
  ),
  index('correction_request_status_idx').on(t.status),
  index('correction_request_sm_id_idx').on(t.smId),
  index('correction_request_record_idx').on(t.recordId),
]);

export const correctionAttachment = pgTable('correction_attachment', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => correctionRequest.id, { onDelete: 'cascade' }),
  storedPath: text('stored_path').notNull(),
  originalName: text('original_name').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: text('uploaded_by').notNull().references(() => user.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('correction_attachment_request_idx').on(t.requestId)]);

export const correctionEvent = pgTable('correction_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().references(() => correctionRequest.id, { onDelete: 'cascade' }),
  action: eventActionEnum('action').notNull(),
  actorId: text('actor_id').references(() => user.id),
  fromStatus: text('from_status'),
  toStatus: text('to_status'),
  remarks: text('remarks'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('correction_event_request_idx').on(t.requestId, t.createdAt)]);
```

- [ ] **Step 4: Add the partial unique index preventing competing open requests**

Create `drizzle/custom/0002_one_open_correction.sql`:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS correction_one_open_per_field
  ON correction_request (record_id, field_name)
  WHERE status IN ('PENDING', 'RETURNED');
```

drizzle-kit cannot express a partial unique index, and this one carries a real rule from spec §5.6: two reps must not both have an open claim on the same field of the same record, because approving both would produce a lost update.

- [ ] **Step 5: Create `src/db/schema/system.ts`**

```ts
import {
  bigserial, boolean, index, integer, jsonb, pgTable, text, timestamp, uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  actorId: text('actor_id').references(() => user.id, { onDelete: 'set null' }),
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
}, (t) => [
  index('audit_log_action_idx').on(t.action, t.createdAt),
  index('audit_log_entity_idx').on(t.entityType, t.entityId),
  index('audit_log_actor_idx').on(t.actorId, t.createdAt),
]);

export const notification = pgTable('notification', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  isRead: boolean('is_read').notNull().default(false),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('notification_user_idx').on(t.userId, t.isRead, t.createdAt)]);

export const excelExport = pgTable('excel_export', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestedBy: text('requested_by').notNull().references(() => user.id),
  fileName: text('file_name').notNull(),
  storedPath: text('stored_path').notNull(),
  sha256: text('sha256').notNull(),
  rowCount: integer('row_count').notNull().default(0),
  correctionCount: integer('correction_count').notNull().default(0),
  filters: jsonb('filters'),
  downloadCount: integer('download_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`actorId` uses `on delete set null` while `actorEmail` and `actorRole` are plain text copies. That is intentional: the audit row must remain readable after a user record changes or is removed, which is exactly when an audit trail matters most.

- [ ] **Step 6: Create the audit append-only trigger**

Create `drizzle/custom/0003_audit_append_only.sql`:

```sql
CREATE OR REPLACE FUNCTION audit_log_is_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();
```

- [ ] **Step 7: Update `src/db/schema/index.ts`**

```ts
export * from './enums';
export * from './auth';
export * from './records';
export * from './corrections';
export * from './system';
```

- [ ] **Step 8: Add a script that applies the custom SQL files**

Create `scripts/apply-custom-sql.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';

config({ path: '.env.local' });

const dir = join(process.cwd(), 'drizzle', 'custom');

async function main() {
  const url = process.argv[2] === '--test' ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL resolved');
  const pool = new Pool({ connectionString: url });
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await pool.query(sql);
    console.log(`applied ${file}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Add to `package.json` scripts:

```json
"db:custom": "tsx scripts/apply-custom-sql.ts",
"db:custom:test": "tsx scripts/apply-custom-sql.ts --test"
```

Every statement in those files is `IF NOT EXISTS` or `CREATE OR REPLACE`, so re-running is safe.

- [ ] **Step 9: Generate and apply migrations to both databases**

```bash
npm run db:generate
npm run db:migrate
npm run db:custom
```

Then the test database (PowerShell):

```powershell
$env:DATABASE_URL = (Select-String -Path .env.local -Pattern '^DATABASE_URL_TEST=(.*)$').Matches.Groups[1].Value
npx drizzle-kit migrate
npm run db:custom:test
```

- [ ] **Step 10: Update `truncateAll` in `tests/helpers/db.ts`**

Replace the `truncateAll` function body with:

```ts
export async function truncateAll() {
  await db.execute(sql`
    truncate table
      "correction_event", "correction_attachment", "correction_request",
      "sales_record_version", "sales_record",
      "upload_batch_row", "upload_batch",
      "audit_log", "notification", "excel_export",
      "session", "account", "verification", "user"
    restart identity cascade
  `);
}
```

- [ ] **Step 11: Write the failing constraints test**

Create `tests/db/constraints.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { auditLog, correctionRequest, salesRecord } from '@/db/schema';
import { truncateAll, makeUser } from '../helpers/db';

async function makeRecord(appsNo = '6167509575', smId = 'ICCSP90766') {
  const [row] = await db.insert(salesRecord).values({ appsNo, smId }).returning();
  return row;
}

describe('domain constraints', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await pool.end();
  });

  it('rejects a lowercase SM_ID on a sales record', async () => {
    await expect(
      db.insert(salesRecord).values({ appsNo: '1', smId: 'c2cm21350' }),
    ).rejects.toThrow(/sales_record_sm_id_uppercase/);
  });

  it('rejects an OTHERS correction with no description', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    await expect(
      db.insert(correctionRequest).values({
        recordId: record.id,
        appsNo: record.appsNo,
        category: 'OTHERS',
        fieldName: 'pay_mode',
        fieldLabel: 'Pay Mode',
        proposedValue: 'UPI',
        description: '   ',
        submittedBy: actor.id,
        smId: 'ICCSP90766',
      }),
    ).rejects.toThrow(/correction_others_requires_description/);
  });

  it('allows an AUTOPAY correction with no description', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    const [row] = await db.insert(correctionRequest).values({
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'AUTOPAY',
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      proposedValue: 'Yes',
      submittedBy: actor.id,
      smId: 'ICCSP90766',
    }).returning();
    expect(row.status).toBe('PENDING');
  });

  it('prevents two open corrections on the same record and field', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    const base = {
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'AUTOPAY' as const,
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      proposedValue: 'Yes',
      submittedBy: actor.id,
      smId: 'ICCSP90766',
    };
    await db.insert(correctionRequest).values(base);
    await expect(db.insert(correctionRequest).values(base)).rejects.toThrow(
      /correction_one_open_per_field/,
    );
  });

  it('allows a new request once the previous one is resolved', async () => {
    const actor = await makeUser({ role: 'sales', smId: 'ICCSP90766' });
    const record = await makeRecord();
    const base = {
      recordId: record.id,
      appsNo: record.appsNo,
      category: 'AUTOPAY' as const,
      fieldName: 'autopay',
      fieldLabel: 'AutoPay',
      proposedValue: 'Yes',
      submittedBy: actor.id,
      smId: 'ICCSP90766',
    };
    const [first] = await db.insert(correctionRequest).values(base).returning();
    await db.update(correctionRequest)
      .set({ status: 'REJECTED' })
      .where(sql`id = ${first.id}`);
    const [second] = await db.insert(correctionRequest).values(base).returning();
    expect(second.id).not.toBe(first.id);
  });

  it('refuses to update an audit_log row', async () => {
    const [row] = await db.insert(auditLog).values({
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: 'abc',
      actorEmail: 'a@example.test',
      actorRole: 'admin',
    }).returning();
    await expect(
      db.update(auditLog).set({ action: 'TAMPERED' }).where(sql`id = ${row.id}`),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses to delete an audit_log row', async () => {
    const [row] = await db.insert(auditLog).values({
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: 'abc',
      actorEmail: 'a@example.test',
      actorRole: 'admin',
    }).returning();
    await expect(db.delete(auditLog).where(sql`id = ${row.id}`)).rejects.toThrow(/append-only/);
  });
});
```

- [ ] **Step 12: Run the test**

```bash
npm test -- tests/db/constraints.test.ts
```

Expected: 7 passed. If `correction_one_open_per_field` is not found, `npm run db:custom:test` did not run against the test database.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add domain schema with correction and audit invariants"
```

---

## Task 4: Better Auth

**Files:**
- Create: `src/lib/auth/server.ts`, `src/lib/auth/client.ts`, `src/app/api/auth/[...all]/route.ts`
- Create: `tests/lib/auth.test.ts`

**Interfaces:**
- Consumes: `db` from `src/db/client.ts`, schema tables from `src/db/schema`
- Produces: `auth` (Better Auth instance) from `src/lib/auth/server.ts` with `auth.api.getSession({ headers })` and `auth.api.signUpEmail(...)`; `authClient` with `signIn`, `signOut`, `useSession` from `src/lib/auth/client.ts`

- [ ] **Step 1: Create `src/lib/auth/server.ts`**

```ts
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@/db/client';
import * as schema from '@/db/schema';
import { env } from '@/lib/env';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 12,
  },
  session: {
    expiresIn: 60 * 60 * 8,
    updateAge: 60 * 60,
  },
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 5,
  },
  user: {
    additionalFields: {
      role: { type: 'string', required: false, input: false, defaultValue: 'sales' },
      smId: { type: 'string', required: false, input: false },
      isActive: { type: 'boolean', required: false, input: false, defaultValue: true },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
```

`input: false` on `role`, `smId`, and `isActive` is a security control, not a typing detail: it prevents those fields being set from request payloads, so nobody can self-assign `admin` through a sign-up or profile-update call.

- [ ] **Step 2: Create `src/lib/auth/client.ts`**

```ts
'use client';

import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
});

export const { signIn, signOut, useSession } = authClient;
```

- [ ] **Step 3: Create the route handler**

Create `src/app/api/auth/[...all]/route.ts`:

```ts
import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth/server';

export const { GET, POST } = toNextJsHandler(auth.handler);
```

- [ ] **Step 4: Add `NEXT_PUBLIC_APP_URL` to `.env.local` and `.env.example`**

```
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

- [ ] **Step 5: Write the failing auth test**

Create `tests/lib/auth.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { user } from '@/db/schema';
import { auth } from '@/lib/auth/server';
import { truncateAll } from '../helpers/db';

const EMAIL = 'admin@example.test';
const PASSWORD = 'correct-horse-battery';

async function createAccount(role: 'admin' | 'sales' | 'approver', smId: string | null) {
  await auth.api.signUpEmail({
    body: { email: EMAIL, password: PASSWORD, name: 'Test User' },
  });
  await db.update(user).set({ role, smId }).where(eq(user.email, EMAIL));
}

describe('better auth', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await pool.end();
  });

  it('creates an account through the server API and signs in', async () => {
    await createAccount('admin', null);

    const result = await auth.api.signInEmail({
      body: { email: EMAIL, password: PASSWORD },
      asResponse: true,
    });

    expect(result.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    await createAccount('admin', null);

    const result = await auth.api.signInEmail({
      body: { email: EMAIL, password: 'wrong-password-entirely' },
      asResponse: true,
    });

    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it('stores a hashed password, never the plaintext', async () => {
    await createAccount('admin', null);
    const rows = await db.query.account.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].password).toBeTruthy();
    expect(rows[0].password).not.toContain(PASSWORD);
  });

  it('does not let role be set from the sign-up payload', async () => {
    await auth.api.signUpEmail({
      body: {
        email: 'sneaky@example.test',
        password: PASSWORD,
        name: 'Sneaky',
        role: 'admin',
      } as never,
    });
    const row = await db.query.user.findFirst({
      where: eq(user.email, 'sneaky@example.test'),
    });
    expect(row?.role).toBe('sales');
  });
});
```

The last test is the one that matters. It proves privilege escalation through the sign-up payload is closed — if a future config change drops `input: false`, this test fails.

- [ ] **Step 6: Run the test**

```bash
npm test -- tests/lib/auth.test.ts
```

Expected: 4 passed.

Note: `signUpEmail` works from the server API even though `disableSignUp: true` blocks the public HTTP route. That is the intended mechanism for admin-created accounts.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire Better Auth with database sessions and no public signup"
```

---

## Task 5: RBAC helpers

**Files:**
- Create: `src/lib/auth/errors.ts`, `src/lib/auth/rbac.ts`
- Create: `tests/lib/rbac.test.ts`

**Interfaces:**
- Consumes: `auth` from `src/lib/auth/server.ts`, `salesRecord` from `src/db/schema`
- Produces:
  - `class AuthzError extends Error { code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INACTIVE' }`
  - `getSession(): Promise<SessionUser | null>`
  - `requireSession(): Promise<SessionUser>`
  - `requireRole(...roles: Role[]): Promise<SessionUser>`
  - `scopedRecordCondition(u: SessionUser): SQL | undefined`
  - `type SessionUser = { id, email, name, role, smId, isActive }`

- [ ] **Step 1: Create `src/lib/auth/errors.ts`**

```ts
export type AuthzCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INACTIVE';

export class AuthzError extends Error {
  constructor(public readonly code: AuthzCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthzError';
  }
}
```

- [ ] **Step 2: Create `src/lib/auth/rbac.ts`**

```ts
import { headers } from 'next/headers';
import { eq, type SQL } from 'drizzle-orm';
import { auth } from './server';
import { AuthzError } from './errors';
import { salesRecord } from '@/db/schema';

export type Role = 'admin' | 'sales' | 'approver';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  smId: string | null;
  isActive: boolean;
};

export async function getSession(): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user) return null;
  const u = result.user as unknown as SessionUser;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    smId: u.smId ? u.smId.toUpperCase() : null,
    isActive: u.isActive,
  };
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new AuthzError('UNAUTHENTICATED');
  if (!user.isActive) throw new AuthzError('INACTIVE');
  return user;
}

export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireSession();
  if (!roles.includes(user.role)) throw new AuthzError('FORBIDDEN');
  return user;
}

/**
 * The only sanctioned way to scope record reads. Admins and approvers see
 * everything; a sales user is confined to their own SM_ID. A sales user with
 * no SM_ID is a misconfiguration, and this throws rather than silently
 * returning an unfiltered query.
 */
export function scopedRecordCondition(user: SessionUser): SQL | undefined {
  if (user.role === 'admin' || user.role === 'approver') return undefined;
  if (!user.smId) throw new AuthzError('FORBIDDEN', 'Sales user has no SM_ID');
  return eq(salesRecord.smId, user.smId);
}
```

The throw on a missing `SM_ID` is deliberate. The alternative — returning `undefined`, meaning "no filter" — would turn a misconfigured sales account into one that sees every record in the system. Failing loudly is the only safe direction for that branch.

- [ ] **Step 3: Write the failing RBAC test**

Create `tests/lib/rbac.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { AuthzError } from '@/lib/auth/errors';
import { scopedRecordCondition, type SessionUser } from '@/lib/auth/rbac';

function makeSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    email: 'u1@example.test',
    name: 'User One',
    role: 'sales',
    smId: 'ICCSP90766',
    isActive: true,
    ...overrides,
  };
}

describe('scopedRecordCondition', () => {
  it('returns no condition for an admin', () => {
    expect(scopedRecordCondition(makeSessionUser({ role: 'admin', smId: null }))).toBeUndefined();
  });

  it('returns no condition for an approver', () => {
    expect(scopedRecordCondition(makeSessionUser({ role: 'approver', smId: null }))).toBeUndefined();
  });

  it('returns a condition for a sales user', () => {
    const condition = scopedRecordCondition(makeSessionUser());
    expect(condition).toBeDefined();
  });

  it('throws for a sales user with no SM_ID rather than returning an unscoped query', () => {
    expect(() => scopedRecordCondition(makeSessionUser({ smId: null }))).toThrow(AuthzError);
  });
});
```

- [ ] **Step 4: Run the test**

```bash
npm test -- tests/lib/rbac.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add RBAC helpers with fail-closed sales scoping"
```

---

## Task 6: Audit log service

**Files:**
- Create: `src/lib/audit/actions.ts`, `src/lib/audit/log.ts`
- Create: `tests/lib/audit.test.ts`

**Interfaces:**
- Consumes: `db` from `src/db/client.ts`, `auditLog` from `src/db/schema`, `SessionUser` from `src/lib/auth/rbac.ts`
- Produces: `type AuditAction` (string union) from `actions.ts`; `writeAudit(input: AuditInput, tx?): Promise<void>` from `log.ts`, where `AuditInput = { actor, action, entityType, entityId?, before?, after?, metadata?, ipAddress?, userAgent? }`

- [ ] **Step 1: Create `src/lib/audit/actions.ts`**

```ts
export const AUDIT_ACTIONS = [
  'AUTH_LOGIN',
  'AUTH_LOGIN_FAILED',
  'AUTH_LOGOUT',
  'USER_CREATE',
  'USER_UPDATE',
  'USER_DEACTIVATE',
  'UPLOAD_CREATE',
  'UPLOAD_MAPPING_SET',
  'UPLOAD_VALIDATE',
  'UPLOAD_COMMIT',
  'UPLOAD_ABORT',
  'UPLOAD_ORIGINAL_DOWNLOAD',
  'RECORD_UPDATE',
  'RECORD_CONFLICT_RESOLVE',
  'RECORD_LOOKUP',
  'CORRECTION_SUBMIT',
  'CORRECTION_RESUBMIT',
  'CORRECTION_APPROVE',
  'CORRECTION_REJECT',
  'CORRECTION_RETURN',
  'CORRECTION_WITHDRAW',
  'ATTACHMENT_UPLOAD',
  'ATTACHMENT_VIEW',
  'EXPORT_GENERATE',
  'EXPORT_DOWNLOAD',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
```

`RECORD_LOOKUP` covers the cross-scope `Apps_No` lookup of spec §7.2, which must be audited whether or not it matches.

- [ ] **Step 2: Create `src/lib/audit/log.ts`**

```ts
import { db } from '@/db/client';
import { auditLog } from '@/db/schema';
import type { AuditAction } from './actions';
import type { SessionUser } from '@/lib/auth/rbac';

type Actor = Pick<SessionUser, 'id' | 'email' | 'role'> | null;

export type AuditInput = {
  actor: Actor;
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type Executor = Pick<typeof db, 'insert'>;

export async function writeAudit(input: AuditInput, tx?: Executor): Promise<void> {
  const executor = tx ?? db;
  await executor.insert(auditLog).values({
    actorId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    actorRole: input.actor?.role ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    metadata: input.metadata ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
}
```

The optional `tx` parameter is what lets an approval write its audit row inside the same transaction as the data change (spec §7.3). An audit entry that commits separately from the change it describes can drift from the truth.

- [ ] **Step 3: Write the failing audit test**

Create `tests/lib/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '@/db/client';
import { auditLog, user } from '@/db/schema';
import { writeAudit } from '@/lib/audit/log';
import { truncateAll, makeUser } from '../helpers/db';

describe('writeAudit', () => {
  beforeEach(truncateAll);
  afterAll(async () => {
    await pool.end();
  });

  it('denormalizes actor email and role onto the row', async () => {
    const actor = await makeUser({ role: 'approver', email: 'app@example.test', smId: null });
    await writeAudit({
      actor: { id: actor.id, email: actor.email, role: 'approver' },
      action: 'CORRECTION_APPROVE',
      entityType: 'correction_request',
      entityId: 'req-1',
    });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorEmail).toBe('app@example.test');
    expect(rows[0].actorRole).toBe('approver');
  });

  it('records before and after payloads', async () => {
    await writeAudit({
      actor: null,
      action: 'RECORD_UPDATE',
      entityType: 'sales_record',
      entityId: 'rec-1',
      before: { autopay: null },
      after: { autopay: 'Yes' },
    });
    const rows = await db.select().from(auditLog);
    expect(rows[0].before).toEqual({ autopay: null });
    expect(rows[0].after).toEqual({ autopay: 'Yes' });
  });

  it('survives deletion of the acting user', async () => {
    const actor = await makeUser({ role: 'admin', email: 'gone@example.test', smId: null });
    await writeAudit({
      actor: { id: actor.id, email: actor.email, role: 'admin' },
      action: 'UPLOAD_COMMIT',
      entityType: 'upload_batch',
      entityId: 'batch-1',
    });
    await db.delete(user).where(eq(user.id, actor.id));
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].actorEmail).toBe('gone@example.test');
  });

  it('rolls back with the transaction it participates in', async () => {
    await expect(
      db.transaction(async (tx) => {
        await writeAudit(
          { actor: null, action: 'UPLOAD_COMMIT', entityType: 'upload_batch', entityId: 'b1' },
          tx,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run the test**

```bash
npm test -- tests/lib/audit.test.ts
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add transaction-aware audit log service"
```

---

## Task 7: First-admin setup script

**Files:**
- Create: `scripts/setup-admin.ts`

**Interfaces:**
- Consumes: `auth` from `src/lib/auth/server.ts`, `db` and `user` from the schema
- Produces: `npm run setup:admin` command

- [ ] **Step 1: Create `scripts/setup-admin.ts`**

```ts
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { config } from 'dotenv';
import { eq, sql } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
  const { db, pool } = await import('../src/db/client');
  const { user } = await import('../src/db/schema');
  const { auth } = await import('../src/lib/auth/server');

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(user);

  if (count > 0) {
    console.error(
      `Refusing to run: ${count} user(s) already exist.\n` +
        'Create further accounts from the Admin > Users screen.',
    );
    await pool.end();
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const name = (await rl.question('Admin full name: ')).trim();
  const email = (await rl.question('Admin email: ')).trim().toLowerCase();
  const password = (await rl.question('Admin password (min 12 chars): ')).trim();
  rl.close();

  if (!name || !email || password.length < 12) {
    console.error('Name and email are required, and the password must be at least 12 characters.');
    await pool.end();
    process.exit(1);
  }

  await auth.api.signUpEmail({ body: { email, password, name } });
  await db.update(user).set({ role: 'admin', smId: null, isActive: true }).where(eq(user.email, email));

  console.log(`\nAdmin account created for ${email}. Sign in at ${process.env.BETTER_AUTH_URL}/login`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
```

The dynamic imports are required: `src/lib/env.ts` validates `process.env` at module load, so `dotenv` must populate it first.

- [ ] **Step 2: Run it against the dev database**

```bash
npm run setup:admin
```

Enter a name, an email, and a password of at least 12 characters.
Expected: `Admin account created for <email>.`

- [ ] **Step 3: Run it a second time to verify it refuses**

```bash
npm run setup:admin
```

Expected: `Refusing to run: 1 user(s) already exist.` and exit code 1.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add first-admin setup script that refuses to re-run"
```

---

## Task 8: Login, middleware, and role routing

**Files:**
- Create: `src/components/login-form.tsx`, `src/app/login/page.tsx`, `src/middleware.ts`
- Modify: `src/app/page.tsx`
- Create: `src/lib/auth/redirects.ts`
- Create: `tests/lib/redirects.test.ts`

**Interfaces:**
- Consumes: `authClient` from `src/lib/auth/client.ts`, `getSession` from `src/lib/auth/rbac.ts`
- Produces: `dashboardPathForRole(role: Role): string` from `src/lib/auth/redirects.ts`; `ROLE_PREFIXES` mapping each role to its route prefix

- [ ] **Step 1: Create `src/lib/auth/redirects.ts`**

```ts
import type { Role } from './rbac';

export const ROLE_PREFIXES: Record<Role, string> = {
  admin: '/admin',
  sales: '/sales',
  approver: '/approver',
};

export function dashboardPathForRole(role: Role): string {
  return ROLE_PREFIXES[role];
}

export function roleForPath(pathname: string): Role | null {
  const entry = (Object.entries(ROLE_PREFIXES) as Array<[Role, string]>).find(
    ([, prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  return entry ? entry[0] : null;
}
```

- [ ] **Step 2: Write the failing redirect test**

Create `tests/lib/redirects.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { dashboardPathForRole, roleForPath } from '@/lib/auth/redirects';

describe('role routing', () => {
  it('maps each role to its dashboard', () => {
    expect(dashboardPathForRole('admin')).toBe('/admin');
    expect(dashboardPathForRole('sales')).toBe('/sales');
    expect(dashboardPathForRole('approver')).toBe('/approver');
  });

  it('identifies the owning role of a path', () => {
    expect(roleForPath('/admin')).toBe('admin');
    expect(roleForPath('/admin/uploads/new')).toBe('admin');
    expect(roleForPath('/sales/records')).toBe('sales');
    expect(roleForPath('/approver/queue')).toBe('approver');
  });

  it('returns null for unowned paths', () => {
    expect(roleForPath('/login')).toBeNull();
    expect(roleForPath('/')).toBeNull();
  });

  it('does not match a prefix that is only a substring', () => {
    expect(roleForPath('/administration')).toBeNull();
    expect(roleForPath('/salesforce')).toBeNull();
  });
});
```

The final assertion guards a real bug: a naive `startsWith('/admin')` would hand `/administration` to the admin guard.

- [ ] **Step 3: Run the test**

```bash
npm test -- tests/lib/redirects.test.ts
```

Expected: 4 passed.

- [ ] **Step 4: Create `src/middleware.ts`**

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { roleForPath } from '@/lib/auth/redirects';

/**
 * Middleware only redirects. It performs an optimistic cookie check and never
 * decides authorization — every page and action re-checks the session and role
 * server-side via requireRole. See spec section 4.1.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const owningRole = roleForPath(pathname);
  if (!owningRole) return NextResponse.next();

  const cookie = getSessionCookie(request);
  if (!cookie) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/sales/:path*', '/approver/:path*'],
};
```

- [ ] **Step 5: Create `src/components/login-form.tsx`**

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth/client';

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);

    const { error: signInError } = await signIn.email({ email, password });

    if (signInError) {
      setError('Incorrect email or password.');
      setPending(false);
      return;
    }

    router.push(next ?? '/');
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-700">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
```

The error message is deliberately identical for an unknown email and a wrong password. Distinguishing them would let an unauthenticated caller enumerate valid accounts.

- [ ] **Step 6: Create `src/app/login/page.tsx`**

```tsx
import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { getSession } from '@/lib/auth/rbac';
import { dashboardPathForRole } from '@/lib/auth/redirects';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const session = await getSession();
  if (session?.isActive) redirect(dashboardPathForRole(session.role));

  const { next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Sales Reconciliation Portal</h1>
        <p className="mt-1 mb-6 text-sm text-slate-500">Sign in to continue</p>
        <LoginForm next={next} />
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Replace `src/app/page.tsx`**

```tsx
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/rbac';
import { dashboardPathForRole } from '@/lib/auth/redirects';

export default async function RootPage() {
  const session = await getSession();
  if (!session || !session.isActive) redirect('/login');
  redirect(dashboardPathForRole(session.role));
}
```

- [ ] **Step 8: Verify the flow manually**

```bash
npm run dev
```

- Visit `http://localhost:3000/admin` while signed out. Expected: redirect to `/login?next=%2Fadmin`.
- Sign in with the admin account from Task 7. Expected: landing on `/admin` (which 404s until Task 9 — that is correct at this point).
- Visit `http://localhost:3000/login` while signed in. Expected: redirect to `/admin`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add login, middleware redirects, and role-based routing"
```

---

## Task 9: App shell, role dashboards, and security headers

**Files:**
- Create: `src/components/app-shell.tsx`, `src/components/sign-out-button.tsx`
- Create: `src/app/admin/layout.tsx`, `src/app/admin/page.tsx`
- Create: `src/app/sales/layout.tsx`, `src/app/sales/page.tsx`
- Create: `src/app/approver/layout.tsx`, `src/app/approver/page.tsx`
- Create: `src/app/forbidden/page.tsx`
- Modify: `next.config.ts`
- Create: `tests/lib/nav.test.ts`
- Create: `src/lib/nav.ts`

**Interfaces:**
- Consumes: `requireRole` from `src/lib/auth/rbac.ts`, `AuthzError` from `src/lib/auth/errors.ts`
- Produces: `navForRole(role: Role): NavItem[]` from `src/lib/nav.ts`, where `NavItem = { href: string; label: string }`; `<AppShell user role>` component

- [ ] **Step 1: Create `src/lib/nav.ts`**

```ts
import type { Role } from '@/lib/auth/rbac';

export type NavItem = { href: string; label: string };

const NAV: Record<Role, NavItem[]> = {
  admin: [
    { href: '/admin', label: 'Dashboard' },
    { href: '/admin/uploads', label: 'Uploads' },
    { href: '/admin/records', label: 'Records' },
    { href: '/admin/corrections', label: 'Corrections' },
    { href: '/admin/exports', label: 'Exports' },
    { href: '/admin/users', label: 'Users' },
    { href: '/admin/audit', label: 'Audit log' },
  ],
  sales: [
    { href: '/sales', label: 'Dashboard' },
    { href: '/sales/records', label: 'My records' },
    { href: '/sales/requests', label: 'My requests' },
  ],
  approver: [
    { href: '/approver', label: 'Dashboard' },
    { href: '/approver/queue', label: 'Pending queue' },
    { href: '/approver/history', label: 'History' },
  ],
};

export function navForRole(role: Role): NavItem[] {
  return NAV[role];
}
```

- [ ] **Step 2: Write the failing nav test**

Create `tests/lib/nav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { navForRole } from '@/lib/nav';
import { roleForPath } from '@/lib/auth/redirects';

describe('navForRole', () => {
  it('gives admins the upload and audit entries', () => {
    const hrefs = navForRole('admin').map((i) => i.href);
    expect(hrefs).toContain('/admin/uploads');
    expect(hrefs).toContain('/admin/audit');
  });

  it('never offers a sales user an admin or approver link', () => {
    const hrefs = navForRole('sales').map((i) => i.href);
    expect(hrefs.every((h) => roleForPath(h) === 'sales')).toBe(true);
  });

  it('never offers an approver an admin link', () => {
    const hrefs = navForRole('approver').map((i) => i.href);
    expect(hrefs.every((h) => roleForPath(h) === 'approver')).toBe(true);
  });
});
```

These assertions are structural rather than hardcoded lists, so they keep holding as navigation grows — and they fail immediately if someone pastes an `/admin/...` link into the sales menu.

- [ ] **Step 3: Run the test**

```bash
npm test -- tests/lib/nav.test.ts
```

Expected: 3 passed.

- [ ] **Step 4: Create `src/components/sign-out-button.tsx`**

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { signOut } from '@/lib/auth/client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await signOut();
        router.push('/login');
        router.refresh();
      }}
      className="text-sm text-slate-500 hover:text-slate-900"
    >
      Sign out
    </button>
  );
}
```

- [ ] **Step 5: Create `src/components/app-shell.tsx`**

```tsx
import Link from 'next/link';
import type { ReactNode } from 'react';
import { navForRole } from '@/lib/nav';
import type { SessionUser } from '@/lib/auth/rbac';
import { SignOutButton } from './sign-out-button';

const ROLE_LABEL: Record<SessionUser['role'], string> = {
  admin: 'Administrator',
  sales: 'Sales',
  approver: 'Approver',
};

export function AppShell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const items = navForRole(user.role);

  return (
    <div className="flex min-h-screen bg-slate-50">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-5 py-4">
          <p className="text-sm font-semibold text-slate-900">Reconciliation</p>
          <p className="text-xs text-slate-500">{ROLE_LABEL[user.role]}</p>
        </div>
        <nav className="p-3">
          <ul className="space-y-1">
            {items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
          <div>
            <p className="text-sm font-medium text-slate-900">{user.name}</p>
            <p className="text-xs text-slate-500">
              {user.email}
              {user.smId ? ` · ${user.smId}` : ''}
            </p>
          </div>
          <SignOutButton />
        </header>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Create `src/app/forbidden/page.tsx`**

```tsx
import Link from 'next/link';

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-slate-900">Not available</h1>
        <p className="mt-2 text-sm text-slate-600">
          You do not have access to that page.
        </p>
        <Link href="/" className="mt-4 inline-block text-sm text-slate-900 underline">
          Return to your dashboard
        </Link>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Create the three role layouts**

`src/app/admin/layout.tsx`:

```tsx
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  try {
    const user = await requireRole('admin');
    return <AppShell user={user}>{children}</AppShell>;
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }
}
```

`src/app/sales/layout.tsx` — identical but with `requireRole('sales')` and the function renamed `SalesLayout`:

```tsx
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';

export default async function SalesLayout({ children }: { children: ReactNode }) {
  try {
    const user = await requireRole('sales');
    return <AppShell user={user}>{children}</AppShell>;
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }
}
```

`src/app/approver/layout.tsx`:

```tsx
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { requireRole } from '@/lib/auth/rbac';
import { AuthzError } from '@/lib/auth/errors';

export default async function ApproverLayout({ children }: { children: ReactNode }) {
  try {
    const user = await requireRole('approver');
    return <AppShell user={user}>{children}</AppShell>;
  } catch (error) {
    if (error instanceof AuthzError) {
      redirect(error.code === 'FORBIDDEN' ? '/forbidden' : '/login');
    }
    throw error;
  }
}
```

`redirect()` throws internally, so it must sit outside the `try` body's success path — it is placed in the `catch` here, which is correct.

- [ ] **Step 8: Create the three dashboard placeholders**

`src/app/admin/page.tsx`:

```tsx
export default function AdminDashboard() {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Admin dashboard</h1>
      <p className="mt-1 text-sm text-slate-600">
        Upload the master workbook to begin. Metrics appear once a batch is committed.
      </p>
    </div>
  );
}
```

`src/app/sales/page.tsx`:

```tsx
export default function SalesDashboard() {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">My dashboard</h1>
      <p className="mt-1 text-sm text-slate-600">
        Your records and correction requests appear here once data has been imported.
      </p>
    </div>
  );
}
```

`src/app/approver/page.tsx`:

```tsx
export default function ApproverDashboard() {
  return (
    <div>
      <h1 className="text-lg font-semibold text-slate-900">Approver dashboard</h1>
      <p className="mt-1 text-sm text-slate-600">
        Pending correction requests appear here once salespeople begin submitting.
      </p>
    </div>
  );
}
```

- [ ] **Step 9: Add security headers to `next.config.ts`**

```ts
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
```

`img-src` allows `blob:` because Plan 3's proof preview renders fetched attachments as object URLs. `script-src` keeps `'unsafe-inline'` because Next.js injects inline bootstrap scripts; tightening this to a nonce is worth doing later but is not a Plan 1 concern.

- [ ] **Step 10: Verify headers and role guards end to end**

```bash
npm run dev
```

In a second terminal:

```bash
curl -s -D - -o /dev/null http://localhost:3000/login | grep -i "content-security-policy\|x-frame-options"
```

Expected: both headers present.

Then in a browser, signed in as the Task 7 admin:

- Visit `/admin`. Expected: the shell renders with seven nav links.
- Visit `/sales`. Expected: redirect to `/forbidden` — the admin's role does not satisfy `requireRole('sales')`.
- Visit `/approver`. Expected: redirect to `/forbidden`.

That second check is the important one. It demonstrates the guard is doing real work, and that an admin is not implicitly granted every role.

- [ ] **Step 11: Run the full test suite**

```bash
npm test
```

Expected: all suites pass — `connection`, `auth-schema`, `constraints`, `auth`, `rbac`, `audit`, `redirects`, `nav`.

- [ ] **Step 12: Verify the production build compiles**

```bash
npm run build
```

Expected: build completes with no type errors.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add app shell, role dashboards, and security headers"
```

---

## Definition of done for Plan 1

- `docker compose up -d` brings up Postgres with `pg_trgm` in both databases.
- `npm run db:migrate && npm run db:custom` produces the full schema.
- `npm run setup:admin` creates exactly one admin and refuses to run again.
- An admin can sign in and reach `/admin`; `/sales` and `/approver` redirect to `/forbidden`.
- `npm test` passes every suite.
- `npm run build` compiles clean.

Database invariants proven by tests, not merely intended: sales users cannot exist without an `SM_ID`; `sm_id` cannot be stored lowercase; an `OTHERS` correction cannot exist without a description; two open corrections cannot target the same field of the same record; `audit_log` rows cannot be updated or deleted; and `role` cannot be set through a sign-up payload.

## What Plan 2 will add

Import pipeline per spec §6: SheetJS `.xlsb` reading with a sheet allowlist, the `-` sentinel and `SM_ID` uppercase normalization, Excel serial date conversion, status-conditional gap detection (§6.4), staging into `upload_batch_row`, the admin column-mapping screen, duplicate detection, the re-import conflict policy (§6.8), and record browsing with search, filters, and pagination.
