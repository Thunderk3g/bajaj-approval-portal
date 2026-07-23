/**
 * First-run bootstrap: creates the single administrator account that every
 * other account is then created from.
 *
 * The script is deliberately one-shot. It counts rows in `user` before doing
 * anything else and refuses outright if the table is not empty, so it can never
 * be used to quietly mint a second administrator on a running deployment. That
 * refusal is the security control here, not a convenience check.
 *
 * Module load order matters. `src/lib/env.ts` validates process.env at import
 * time and throws when a variable is missing, and `src/lib/auth/server` pulls
 * it in transitively. Static imports are hoisted above the `config()` call
 * below, so anything that reaches env must be loaded with a dynamic
 * `await import(...)` instead — otherwise the script dies before dotenv has had
 * a chance to populate process.env.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { count } from 'drizzle-orm';
import { config } from 'dotenv';

config({ path: '.env.local' });

const MIN_PASSWORD_LENGTH = 12;

// Deliberately loose. The address only has to be plausible: strict RFC matching
// rejects legitimate addresses, and the real test is whether the person can
// sign in with what they typed.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Number of rows in the `user` table.
 *
 * Exported so the refusal guard can be exercised in tests without driving the
 * interactive prompts.
 */
export async function countExistingUsers(): Promise<number> {
  const { db } = await import('@/db/client');
  const { user } = await import('@/db/schema');
  const [row] = await db.select({ value: count() }).from(user);
  return row?.value ?? 0;
}

async function closePool(): Promise<void> {
  const { pool } = await import('@/db/client');
  await pool.end();
}

/**
 * Prompt-and-read over a readline interface, backed by its line iterator.
 */
function lineReader(rl: Interface): (prompt: string) => Promise<string> {
  const lines = rl[Symbol.asyncIterator]();
  return async (prompt: string) => {
    process.stdout.write(prompt);
    const next = await lines.next();
    if (next.done) throw new Error(`Input ended before "${prompt.trim()}" was answered.`);
    return next.value;
  };
}

/**
 * Runs the interactive bootstrap and resolves to the process exit code.
 *
 * Returning a code rather than exiting inline keeps every exit path funnelling
 * through the same pool teardown below; an open pg pool keeps the event loop
 * alive and the CLI would otherwise hang after printing.
 */
async function main(): Promise<number> {
  const existing = await countExistingUsers();
  if (existing > 0) {
    console.error(
      `Refusing to run: the user table already holds ${existing} account(s).\n` +
        'This script only bootstraps the very first administrator.\n' +
        'Create every further account by signing in as an admin and using Admin > Users.',
    );
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let name: string;
  let email: string;
  let password: string;
  try {
    // rl.question() is unusable when stdin is a pipe rather than a terminal:
    // every piped line arrives in one chunk, and readline drops the lines that
    // land while no question happens to be pending, so only the first answer is
    // ever read. The async iterator queues them properly and works for a real
    // terminal too.
    const ask = lineReader(rl);
    name = (await ask('Full name: ')).trim();
    email = (await ask('Email: ')).trim();
    password = await ask(`Password (min ${MIN_PASSWORD_LENGTH} characters): `);
  } finally {
    rl.close();
  }

  if (!name) {
    console.error('Full name is required.');
    return 1;
  }
  if (!email) {
    console.error('Email is required.');
    return 1;
  }
  if (!EMAIL_PATTERN.test(email)) {
    console.error(`"${email}" does not look like an email address.`);
    return 1;
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`,
    );
    return 1;
  }

  const { createUserAccount } = await import('@/lib/auth/provision');
  const created = await createUserAccount({
    name,
    email,
    password,
    role: 'admin',
    // An admin is not scoped to a sales book, so there is no SM_ID to attach.
    smId: null,
  });

  const baseUrl = process.env.BETTER_AUTH_URL?.replace(/\/+$/, '');
  const signInUrl = baseUrl ? `${baseUrl}/login` : '(BETTER_AUTH_URL is not set)';
  console.log(`Created admin ${created.email}. Sign in at ${signInUrl}`);
  return 0;
}

/**
 * True only when this file is the process entry point.
 *
 * Tests import this module for `countExistingUsers`, and an unguarded call to
 * main() would leave them blocked on a prompt that never gets an answer.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    // realpath.native normalises Windows 8.3 short paths and casing, which
    // argv[1] and import.meta.url do not always agree on.
    return realpathSync.native(entry).toLowerCase() === realpathSync.native(self).toLowerCase();
  } catch {
    return resolve(entry) === resolve(self);
  }
}

if (isEntryPoint()) {
  // process.exitCode rather than process.exit(): on Windows a piped stdout is
  // written asynchronously, and exiting outright drops whatever is still
  // buffered — including the success line. Closing the pool empties the event
  // loop, so node exits on its own with this code once the output has flushed.
  main()
    .then(async (code) => {
      await closePool();
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      await closePool().catch(() => {});
      process.exitCode = 1;
    });
}
