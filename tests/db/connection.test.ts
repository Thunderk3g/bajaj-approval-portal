import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

/**
 * Derives the expected database name from the configured URL rather than
 * hardcoding `sdrp_test`.
 *
 * The point of this assertion is that the suite is pointed at A test database
 * and not at the dev one — tests/setup.ts already refuses to run without
 * DATABASE_URL_TEST, and the suites truncate every table. Pinning one literal
 * name additionally asserted "and it is this specific database", which is not a
 * property worth having: it fails the moment work is split across per-agent
 * databases, and it would still pass if DATABASE_URL_TEST were pointed at
 * production and merely happened to be called sdrp_test.
 */
function expectedDatabaseName(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) throw new Error('DATABASE_URL_TEST is not set');
  return new URL(url).pathname.replace(/^\//, '');
}

describe('database connection', () => {
  it('connects to the configured test database', async () => {
    const result = await db.execute(sql`select current_database() as name`);
    expect(result.rows[0].name).toBe(expectedDatabaseName());
  });

  it('is pointed at a test database, not the dev one', async () => {
    expect(process.env.DATABASE_URL_TEST).not.toBe(process.env.DATABASE_URL);
    expect(expectedDatabaseName()).toMatch(/test/);
  });

  it('has the pg_trgm extension available', async () => {
    const result = await db.execute(sql`select extname from pg_extension where extname = 'pg_trgm'`);
    expect(result.rows).toHaveLength(1);
  });
});
