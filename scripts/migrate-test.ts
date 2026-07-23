/**
 * Applies drizzle migrations to the test database.
 *
 * drizzle-kit reads DATABASE_URL from drizzle.config.ts, so pointing it at the
 * test database means overriding that variable. Doing it here rather than in
 * the shell keeps the command identical across bash and PowerShell.
 */
import { execFileSync } from 'node:child_process';
import { config } from 'dotenv';

config({ path: '.env.local' });

const testUrl = process.env.DATABASE_URL_TEST;
if (!testUrl) {
  console.error('DATABASE_URL_TEST is not set');
  process.exit(1);
}

execFileSync('npx', ['drizzle-kit', 'migrate'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl },
});
