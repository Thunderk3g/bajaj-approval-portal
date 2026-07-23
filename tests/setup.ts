import { afterAll } from 'vitest';
import { config } from 'dotenv';

config({ path: '.env.local' });

process.env.NODE_ENV = 'test';

// A suite that truncates tables must not be one typo away from the dev database.
if (!process.env.DATABASE_URL_TEST) {
  throw new Error('DATABASE_URL_TEST is not set — tests must never run against the dev database');
}

// Close the pool once per test FILE, not per describe block. Registering this
// here rather than in individual suites prevents a describe-level afterAll from
// closing the pool while later describes in the same file still need it.
afterAll(async () => {
  const { pool } = await import('@/db/client');
  await pool.end();
});
