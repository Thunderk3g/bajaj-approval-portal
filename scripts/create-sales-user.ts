/**
 * Creates ONE sales login for a named rep from the roster.
 *
 *   npx tsx scripts/create-sales-user.ts ICCS427343 "Shikha Singh"
 *   npx tsx scripts/create-sales-user.ts C2CM24850 "Iqra Sartaj Khan" iqra.khan@bajajlife.com
 *
 * Deliberately separate from the bulk paths — Admin > Users > Provisioning
 * worklist, and `provision-managers.ts` for the two manager rungs. Both of those
 * are ROSTER-driven and will only touch codes the Manpower sheet places. This one
 * takes the identifier straight from the caller, which is what you need to walk
 * the pipeline as a specific rep before any sheet has been imported.
 *
 * There is no longer a path that derives people from transaction data. The old
 * `provision-sales-users.ts` read `lead` and gave an account to every SM code
 * that owned rows, which is how codes like `DIY` — a bucket for unclaimed
 * business, not a person — ended up being offered logins.
 *
 * Module load order matters. `src/lib/env.ts` validates process.env at import
 * time and throws when a variable is missing, and `@/lib/auth/server` pulls it in
 * transitively. Static imports are hoisted above the `config()` call below, so
 * everything that reaches env is loaded with a dynamic `await import(...)`.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

config({ path: '.env.local' });

/**
 * Matches the `sales_record_sm_id_uppercase` CHECK and its `lead` counterpart.
 *
 * Hyphens are allowed because `111222-UN` is a real value in the source — the
 * "not given to anyone yet" sentinel. It is refused below on its own terms
 * rather than by a character class, so the refusal can say why.
 */
const SM_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

// The sheet's placeholder owners, shared with the worklist and both bulk
// provisioning paths — see src/lib/roster/placeholders.ts. It is imported rather
// than restated because a "not a person" list that disagrees between the screen
// and this script is how one of them creates a login for a bucket.
import { isPlaceholderCode, PLACEHOLDER_REASON } from '@/lib/roster/placeholders';

/** 24 characters, no glyphs that are ambiguous read aloud or over a call. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * `firstname.lastname@bajajlife.com`, falling back to the SM_ID when the name
 * yields nothing usable.
 *
 * Derived from the NAME rather than the code because a rep has to recognise their
 * own address to sign in, and `iccs427343@bajajlife.com` is not something anyone
 * types from memory. Collisions are caught by the existence check below — the
 * roster has several people sharing a surname — and the caller can pass an
 * explicit address to break one.
 */
export function emailFor(name: string, smId: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');

  return `${slug || smId.toLowerCase()}@bajajlife.com`;
}

export function refusalFor(smId: string): string | null {
  if (isPlaceholderCode(smId)) {
    return `${smId} is ${PLACEHOLDER_REASON}. An account for it would be a login with no owner.`;
  }
  if (!SM_ID_PATTERN.test(smId)) {
    return `"${smId}" is not a usable SM_ID. It is uppercased before the check, and the database CHECK constraint requires 3-32 characters of A-Z, 0-9 and hyphen.`;
  }
  return null;
}

async function main(argv: string[]): Promise<number> {
  // An explicit flag, and a verbose one. Resetting a password locks out whoever
  // is holding the old one, with no message anywhere saying why — so it must be
  // something the caller asked for in as many words, never something that
  // happens because they re-ran a create.
  const reset = argv.includes('--reset-password');
  const [rawSmId, rawName, rawEmail] = argv.filter((a) => !a.startsWith('--'));

  if (!rawSmId || (!rawName && !reset)) {
    console.error(
      'Usage: npx tsx scripts/create-sales-user.ts <SM_ID> "<Full Name>" [email]\n' +
        '       npx tsx scripts/create-sales-user.ts <SM_ID> --reset-password\n\n' +
        'Creates one sales login scoped to that SM_ID. The email is derived from\n' +
        'the name unless you pass one.\n\n' +
        '--reset-password issues a new password for an SM_ID that already has an\n' +
        'account. Whoever holds the old one is locked out immediately.',
    );
    return 1;
  }

  // Uppercased before anything else looks at it: the CHECK constraint would
  // otherwise reject a lowercase code at insert time with an opaque error, and
  // a rep whose code was stored lowercase would see none of their own records.
  const smId = rawSmId.trim().toUpperCase();
  const name = rawName?.trim() ?? '';

  const refusal = refusalFor(smId);
  if (refusal) {
    console.error(refusal);
    return 1;
  }

  const { db } = await import('@/db/client');
  const { user, account } = await import('@/db/schema');
  const { and, eq, or } = await import('drizzle-orm');

  const [holder] = await db
    .select({ id: user.id, email: user.email, smId: user.smId, name: user.name })
    .from(user)
    .where(eq(user.smId, smId));

  const password = generatePassword();
  let email: string;
  let displayName: string;

  if (reset) {
    if (!holder) {
      console.error(
        `${smId} has no account to reset. Run without --reset-password, giving the rep's name, to create one.`,
      );
      return 1;
    }

    const { auth } = await import('@/lib/auth/server');
    const ctx = await auth.$context;

    // Updated through Better Auth's own hasher, and scoped to the `credential`
    // provider row. Writing the hash by hand — or updating every account row for
    // this user — produces something that looks right and cannot sign in.
    await db
      .update(account)
      .set({ password: await ctx.password.hash(password) })
      .where(and(eq(account.userId, holder.id), eq(account.providerId, 'credential')));

    email = holder.email;
    displayName = holder.name;
  } else {
    email = (rawEmail?.trim() || emailFor(name, smId)).toLowerCase();

    // Both conditions in one query: an address already taken belongs to someone
    // else, and a code already taken means this rep has an account under a
    // different address. Reporting the wrong one sends the caller looking in the
    // wrong place.
    const existing = await db
      .select({ email: user.email, smId: user.smId, name: user.name })
      .from(user)
      .where(or(eq(user.email, email), eq(user.smId, smId)));

    if (existing.length > 0) {
      for (const row of existing) {
        console.error(
          row.smId === smId
            ? `${smId} already has an account: ${row.email} (${row.name}). Left untouched — re-running must never reset a password somebody is already using. Pass --reset-password if that is what you want.`
            : `The address ${row.email} is already taken by ${row.name} (${row.smId ?? 'no SM_ID'}). Pass a different one as the third argument.`,
        );
      }
      return 1;
    }

    const { createUserAccount } = await import('@/lib/auth/provision');
    await createUserAccount({ name, email, password, role: 'sales', smId });
    displayName = name;
  }

  const baseUrl = process.env.BETTER_AUTH_URL?.replace(/\/+$/, '') ?? '';

  console.log('');
  console.log(`  ${reset ? 'Password reset for an existing account' : 'Account created'}`);
  console.log('');
  console.log(`  SM_ID     ${smId}`);
  console.log(`  Name      ${displayName}`);
  console.log(`  Email     ${email}`);
  console.log(`  Password  ${password}`);
  console.log('');
  console.log(`  Sign in   ${baseUrl ? `${baseUrl}/login` : '(BETTER_AUTH_URL is not set)'}`);
  console.log('');
  console.log('  The password is shown once and is not recoverable.');
  console.log(
    `  This rep sees nothing until a workbook carrying ${smId} is committed —\n` +
      '  scoping is on sm_id, so an account created before the import is simply empty.',
  );

  return 0;
}

export { main };

/** True only when this file is the process entry point, so tests can import it. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync.native(entry).toLowerCase() === realpathSync.native(self).toLowerCase();
  } catch {
    return resolve(entry) === resolve(self);
  }
}

if (isEntryPoint()) {
  // process.exitCode rather than process.exit(): on Windows a piped stdout is
  // written asynchronously and exiting outright drops whatever is still
  // buffered — including the password.
  main(process.argv.slice(2))
    .then(async (code) => {
      const { pool } = await import('@/db/client');
      await pool.end();
      process.exitCode = code;
    })
    .catch(async (error) => {
      console.error(error instanceof Error ? error.message : error);
      const { pool } = await import('@/db/client');
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}
