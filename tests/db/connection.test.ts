import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

describe('database connection', () => {
  it('connects to the test database', async () => {
    const result = await db.execute(sql`select current_database() as name`);
    expect(result.rows[0].name).toBe('sdrp_test');
  });

  it('has the pg_trgm extension available', async () => {
    const result = await db.execute(sql`select extname from pg_extension where extname = 'pg_trgm'`);
    expect(result.rows).toHaveLength(1);
  });
});
