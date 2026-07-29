/**
 * Gives every rep who already owns leads in the imported `Lead Dump` a login.
 *
 * There is no public sign-up — `disableSignUp` in src/lib/auth/server.ts is
 * enforced by Better Auth on the server API too — so an account exists only if
 * something created it server-side. Doing that for ~200 reps one form at a time
 * through Admin > Users is not a real option, and the accounts are the
 * precondition for anybody walking the correction flow as a rep rather than as
 * an admin pretending to be one.
 *
 * Passwords go through `createUserAccount`, which uses Better Auth's own hasher.
 * A bcrypt string written straight into `account.password` by this script would
 * look entirely correct in psql and fail every sign-in, because Better Auth
 * verifies against its own scrypt parameters — the failure surfaces as "the
 * password you gave me is wrong", which sends you looking in the wrong place.
 *
 * Module load order matters here for the reason spelled out at the top of
 * scripts/setup-admin.ts: src/lib/env.ts validates process.env at import time and
 * throws on a missing variable, and @/lib/auth/* reaches it transitively. Static
 * imports hoist above the `config()` call below, so everything touching the
 * database or auth is pulled in with `await import(...)` instead.
 */
import { realpathSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
// Statically imported because it is a zod schema that reaches nothing reading
// env — the load-order note above does not apply to it. Imported rather than
// restated so the codes this script accepts are exactly the codes the
// /admin/users form accepts; see `refusalFor` for why that has to hold.
import { SM_ID_PATTERN } from '@/lib/users/schema';

config({ path: '.env.local' });

/**
 * The Lead Dump's own marker for a lead nobody has been given yet —
 * `UNASSIGNED_SM_CODE` in ingest/app/leads.py, 2.72% of the sampled rows.
 *
 * Restated here rather than imported because the definition lives in Python.
 * The query below already filters on `lead.is_unassigned`, which the ingestion
 * service denormalises from exactly this comparison; the literal is the second
 * belt. A row carrying the sentinel with the flag left false — a hand-edit, an
 * ingestion service one version behind this schema — would otherwise be handed a
 * working login named after a placeholder, and `scopedLeadCondition` would show
 * that login every unowned lead in the system.
 */
const UNASSIGNED_SM_CODE = '111222-UN';

const EMAIL_DOMAIN = 'bajajlife.com';

/**
 * The sign-in address for an SM code.
 *
 * Derived from the code, not from the rep's name. The code is the only stable
 * identifier in this data: `lead.sm_name` is free text off a spreadsheet
 * ("kiran.rokade", "Vishal Kumar097", "0x2a"), and two people share a name far
 * more readily than they share a code. Derivation is also the whole of the
 * idempotency story — the same code resolves to the same address, so a second
 * run recognises the account the first run made instead of minting a duplicate
 * under a new address, and the email column is what carries a rep's identity
 * through the audit trail (see the note on `updateUserSchema`, which refuses to
 * let it be edited for that reason).
 *
 * Lowercased because `createUserAccount` lowercases before inserting and
 * `user.email` is unique, while `sm_id` is stored uppercase. The mapping stays
 * one-to-one: `SM_ID_PATTERN` admits only `[A-Z0-9]`, so lowercasing cannot fold
 * two distinct codes onto one address.
 *
 * The `sm.` prefix keeps these apart from the hand-made accounts already on this
 * deployment (`sm1@`, `verifier@`) and from real staff mailboxes. Nothing sends
 * mail — Better Auth has no transport configured — so this is an identifier that
 * happens to be shaped like an address.
 */
export function emailForSmCode(smCode: string): string {
  return `sm.${smCode.toLowerCase()}@${EMAIL_DOMAIN}`;
}

// No l/I/1 and no O/0. These are read off a printed table and typed by hand
// exactly once; a pair of glyphs nobody can tell apart arrives back as "the
// account you made me does not work", and there is no stored password to check
// it against.
const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Better Auth's floor is 12 (`minPasswordLength`). 16 drawn from this alphabet
// is ~93 bits, costs nothing to type once, and leaves headroom if the floor
// rises.
const PASSWORD_LENGTH = 16;

/**
 * A password nobody has to remember and nobody can guess.
 *
 * `randomInt` rather than `randomBytes(n)[i] % alphabet.length`: 256 is not a
 * multiple of 57, so the modulo draws the first 28 symbols measurably more often
 * than the rest. `randomInt` rejects out-of-range draws instead of folding them.
 */
export function generatePassword(): string {
  let password = '';
  for (let i = 0; i < PASSWORD_LENGTH; i += 1) {
    password += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return password;
}

/**
 * Why an SM code cannot be given an account, or null when it can.
 *
 * The sentinel is caught here rather than filtered out of the query below, so a
 * lead carrying `111222-UN` with `is_unassigned` left false lands in the REFUSED
 * block by name. Filtering it in SQL would drop it silently, and silence is the
 * wrong answer to "the denormalised flag disagrees with the column it was
 * denormalised from".
 *
 * The pattern check is not defensive duplication of the `user_sm_id_uppercase`
 * CHECK, which would accept a hyphen quite happily. It is `SM_ID_PATTERN`, the
 * rule `/admin/users` validates against: an account created here with a code
 * that form rejects is an account no administrator can subsequently edit, because
 * `updateUserSchema` re-validates `smId` on every save. Refusing up front leaves
 * a named code in the report; accepting leaves a trap.
 *
 * Digits alone pass, deliberately — 512454 is a real SM_ID (spec 13.2 note 7).
 */
export function refusalFor(smCode: string): string | null {
  if (smCode === UNASSIGNED_SM_CODE) {
    return 'the Lead Dump sentinel for an unassigned lead, not a rep';
  }
  if (!SM_ID_PATTERN.test(smCode)) {
    return 'not 3-32 characters of A-Z0-9, so /admin/users could never edit the account again';
  }
  return null;
}

export type LeadOwner = {
  smCode: string;
  smName: string | null;
  leads: number;
  /** Has a `manpower` row. See the roster note in the summary output. */
  onRoster: boolean;
};

/**
 * Every SM code owning at least one assigned lead, busiest first.
 *
 * Ordered by lead count with the code as a total tiebreaker, for the same reason
 * `src/lib/leads/queries.ts` appends `lead_no` to its ordering: a non-total order
 * lets Postgres return ties differently per query, and here that would make
 * `--limit` drop an arbitrary tail. Two capped runs must select the same reps, or
 * the operator ends up holding two overlapping halves of the roster with no way
 * to tell which run produced which. Busiest first also means a capped run
 * provisions the reps with something to look at.
 *
 * `min(sm_name)` rather than `mode()`: no code in the current import carries two
 * spellings of its name, and `min` stays deterministic if one ever does, where
 * `mode()` picks arbitrarily among ties.
 */
export async function listLeadOwners(): Promise<LeadOwner[]> {
  const { and, asc, eq, isNotNull, sql } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { lead, manpower } = await import('@/db/schema');

  return db
    .select({
      // Narrowed here rather than re-checked per row: the predicate excludes
      // NULL codes.
      smCode: sql<string>`${lead.smCode}`,
      smName: sql<string | null>`min(${lead.smName})`,
      leads: sql<number>`count(*)::int`,
      onRoster: sql<boolean>`exists (select 1 from ${manpower} where ${manpower.smId} = ${lead.smCode})`,
    })
    .from(lead)
    // `is_unassigned` is the flag the whole application scopes on
    // (`scopedLeadCondition`), so it is the flag this filters on — a second,
    // subtly different definition of "owned" is how a rep ends up with an
    // account the lead list then refuses to show anything for. The sentinel
    // itself is left to `refusalFor`.
    .where(and(isNotNull(lead.smCode), eq(lead.isUnassigned, false)))
    .groupBy(lead.smCode)
    .orderBy(sql`count(*) desc`, asc(lead.smCode));
}

/**
 * How many rows the `Manpower` roster has at all.
 *
 * Asked because "this code has no roster row" means two very different things
 * either side of zero. With rows present it is the stale-sheet case of spec 6.4 —
 * a handful of reps the roster has not caught up with. With no rows at all the
 * roster has simply never been imported, and reporting 200 stale entries would
 * send an admin looking for 200 missing people instead of for one missing sheet.
 */
async function rosterSize(): Promise<number> {
  const { sql } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { manpower } = await import('@/db/schema');

  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(manpower);
  return row?.value ?? 0;
}

/** Leads sitting in the unassigned pool — reported, never provisioned. */
export async function countUnassignedLeads(): Promise<number> {
  const { or, eq, sql } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { lead } = await import('@/db/schema');

  const [row] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(lead)
    .where(or(eq(lead.isUnassigned, true), eq(lead.smCode, UNASSIGNED_SM_CODE)));

  return row?.value ?? 0;
}

/**
 * SM_ID to sign-in address for every account that already holds one.
 *
 * Keyed on `sm_id` rather than on the derived email, and that is the whole point.
 * This deployment's `sm1@bajajlife.com` is ICCSP90766 and `sm2@bajajlife.com` is
 * C2CM21350; both codes own leads. Checking the email alone would find no
 * `sm.iccsp90766@bajajlife.com`, create one, and leave one rep with two logins
 * onto the same book — the second of which quietly becomes the one this script
 * reports as current.
 *
 * Not filtered to `role = 'sales'`: the CHECK constraint permits a non-sales
 * account to carry an SM_ID, and whatever holds the code, a second account for it
 * is still a second account for it.
 */
async function accountsBySmId(): Promise<Map<string, string>> {
  const { isNotNull } = await import('drizzle-orm');
  const { db } = await import('@/db/client');
  const { user } = await import('@/db/schema');

  const rows = await db
    .select({ smId: user.smId, email: user.email })
    .from(user)
    .where(isNotNull(user.smId));

  return new Map(rows.filter((row) => row.smId !== null).map((row) => [row.smId as string, row.email]));
}

export type CreatedAccount = {
  smCode: string;
  email: string;
  password: string;
  name: string;
  leads: number;
};

export type ProvisionReport = {
  /** Codes owning assigned leads, before any cap or refusal. */
  candidates: number;
  created: CreatedAccount[];
  skippedExisting: Array<{ smCode: string; email: string }>;
  refused: Array<{ smCode: string; reason: string }>;
  droppedByLimit: number;
  unassignedLeads: number;
  /** Provisioned codes with no `manpower` row. Flagged, never dropped. */
  offRoster: number;
  /** Rows in `manpower`. Zero means the roster sheet has never been imported. */
  rosterRows: number;
};

export type ProvisionOptions = {
  /** Cap on accounts created this run. null means every candidate. */
  limit: number | null;
  dryRun: boolean;
  /** Called as each account lands, so a crash mid-run cannot take the passwords with it. */
  onCreated?: (account: CreatedAccount) => void;
};

/**
 * Creates one Sales account per unprovisioned lead owner.
 *
 * Deliberately NOT one transaction. A failure at account 150 must leave the
 * first 149 usable: their passwords have already been printed and quite possibly
 * copied, and a rollback would turn every one of those into a credential for an
 * account that does not exist — recoverable only by a rerun that mints different
 * passwords for people already holding the old ones.
 *
 * An existing SM_ID is skipped rather than updated, for the same reason. Reissuing
 * a password would lock out whoever signed in with the previous one, and this
 * script is the only thing that ever knew it.
 */
export async function provisionSalesUsers(options: ProvisionOptions): Promise<ProvisionReport> {
  const { createUserAccount } = await import('@/lib/auth/provision');
  const { writeAudit } = await import('@/lib/audit/log');
  const { rosterStatus } = await import('@/lib/users/queries');

  const owners = await listLeadOwners();
  const existing = await accountsBySmId();

  const report: ProvisionReport = {
    candidates: owners.length,
    created: [],
    skippedExisting: [],
    refused: [],
    droppedByLimit: 0,
    unassignedLeads: await countUnassignedLeads(),
    offRoster: 0,
    rosterRows: await rosterSize(),
  };

  // An empty `lead` table is a normal state, not an error: the running order is
  // reset, upload, import Lead Dump, provision, and somebody will run this at
  // step one. Returning the empty report here rather than letting the loop fall
  // through means the caller can say so plainly instead of printing an empty
  // table under a header.
  if (owners.length === 0) return report;

  for (const owner of owners) {
    const refusal = refusalFor(owner.smCode);
    if (refusal) {
      report.refused.push({ smCode: owner.smCode, reason: refusal });
      continue;
    }

    const held = existing.get(owner.smCode);
    if (held) {
      report.skippedExisting.push({ smCode: owner.smCode, email: held });
      continue;
    }

    // The cap is applied after the refusal and already-provisioned checks, so
    // this counts reps who would have got an account and did not — not
    // "everything past the point the loop stopped", which would include codes
    // that were never going to be provisioned anyway and inflate the number the
    // operator is being asked to act on.
    if (options.limit !== null && report.created.length >= options.limit) {
      report.droppedByLimit += 1;
      continue;
    }

    const email = emailForSmCode(owner.smCode);
    const name = owner.smName?.trim() || owner.smCode;

    if (options.dryRun) {
      const planned = { smCode: owner.smCode, email, password: '(dry run)', name, leads: owner.leads };
      report.created.push(planned);
      if (!owner.onRoster) report.offRoster += 1;
      options.onCreated?.(planned);
      continue;
    }

    const password = generatePassword();

    try {
      const created = await createUserAccount({
        name,
        email,
        password,
        role: 'sales',
        smId: owner.smCode,
      });

      // Read from the database rather than from `owner.onRoster`, matching
      // `createUser` in src/lib/users/service.ts: whether the roster knows this
      // code is a fact about the data at provisioning time, and the trail is the
      // only durable record that the account was machine-provisioned at all —
      // the password is printed once and stored nowhere.
      const roster = await rosterStatus(owner.smCode);

      await writeAudit({
        // System-originated: no session, no actor. `writeAudit` takes null for
        // exactly this case.
        actor: null,
        action: 'USER_CREATE',
        entityType: 'user',
        entityId: created.id,
        after: { name, email, role: 'sales', smId: owner.smCode },
        metadata: {
          via: 'provision-sales-users',
          roster,
          needsRosterReview: roster === 'absent' || roster === 'orphan',
          leads: owner.leads,
        },
      });

      const account = { smCode: owner.smCode, email, password, name, leads: owner.leads };
      report.created.push(account);
      if (!owner.onRoster) report.offRoster += 1;
      options.onCreated?.(account);
    } catch (error) {
      // `createUserAccount` throws on a duplicate email, which here means the
      // address is already held by an account carrying a different SM_ID (or
      // none). That is a name collision a rerun cannot fix, so it is named in
      // the report rather than retried.
      report.refused.push({
        smCode: owner.smCode,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}

/* ----------------------------------------------------------------------- cli */

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function credentialRow(account: CreatedAccount): string {
  return [
    pad(account.smCode, 12),
    pad(account.email, 32),
    pad(account.password, 18),
    padLeft(String(account.leads), 6),
    account.name,
  ].join('  ');
}

const CREDENTIAL_HEADER = [
  pad('SM_ID', 12),
  pad('EMAIL', 32),
  pad('PASSWORD', 18),
  padLeft('LEADS', 6),
  'NAME',
].join('  ');

function parseOptions(argv: string[]): ProvisionOptions {
  let limit: number | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    const inline = arg.startsWith('--limit=') ? arg.slice('--limit='.length) : null;
    if (inline !== null || arg === '--limit') {
      const raw = inline ?? argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--limit needs a positive whole number, got "${raw ?? ''}"`);
      }
      limit = parsed;
      continue;
    }
    throw new Error(`Unknown argument "${arg}". Usage: provision-sales-users [--limit N] [--dry-run]`);
  }

  return { limit, dryRun };
}

async function closePool(): Promise<void> {
  const { pool } = await import('@/db/client');
  await pool.end();
}

/**
 * Runs the provisioning pass and resolves to the process exit code.
 *
 * Returning a code rather than exiting inline keeps every path funnelling
 * through the same pool teardown below; an open pg pool keeps the event loop
 * alive and the CLI would otherwise hang after printing.
 */
async function main(argv: string[]): Promise<number> {
  const options = parseOptions(argv);

  if (options.dryRun) console.log('DRY RUN — nothing will be created.');

  // The header goes out with the first account rather than up front, and every
  // row is printed the moment its account lands. Buffering the table to the end
  // would mean a crash at row 150 discards 149 passwords that already exist in
  // the database and exist nowhere else; printing the header unconditionally
  // would put an empty table above every run that had nothing to do.
  let headerPrinted = false;
  const report = await provisionSalesUsers({
    ...options,
    onCreated: (account) => {
      if (!headerPrinted) {
        console.log(`\n${CREDENTIAL_HEADER}`);
        console.log('-'.repeat(CREDENTIAL_HEADER.length));
        headerPrinted = true;
      }
      console.log(credentialRow(account));
    },
  });

  // The empty table is a normal step in the running order, not a failure, so it
  // says which step is missing rather than just reporting zero.
  if (report.candidates === 0) {
    console.log(
      '\nNo SM codes in the lead table — nothing to provision.' +
        '\nUpload the workbook and run the Lead Dump import first; this script reads `lead`.',
    );
    return 0;
  }

  console.log('');
  console.log(
    options.dryRun
      ? 'Nothing was written. Re-run without --dry-run to create these accounts.'
      : report.created.length > 0
        ? 'Passwords are shown once and stored nowhere. Copy the table above now.'
        : 'Nothing new to create — every lead owner below already has an account.',
  );

  // Every candidate lands in exactly one of these lines. That is the point of
  // printing all six even when they are zero: a number missing from the summary
  // is indistinguishable from a candidate the script dropped without saying so.
  console.log('');
  for (const [label, value] of [
    ['lead owners found', String(report.candidates)],
    ['accounts created', String(report.created.length)],
    ['skipped, already provisioned', String(report.skippedExisting.length)],
    ['skipped, unassigned pool', `${report.unassignedLeads} lead(s) under ${UNASSIGNED_SM_CODE}`],
    ['refused', String(report.refused.length)],
    ['dropped by --limit', String(report.droppedByLimit)],
  ]) {
    console.log(`${pad(label, 30)}${value}`);
  }

  if (report.droppedByLimit > 0) {
    console.log(
      `\n${report.droppedByLimit} unprovisioned lead owner(s) were left out by --limit ${options.limit}. Re-run without it to finish.`,
    );
  }

  if (report.offRoster > 0) {
    // Flagged, never dropped (spec 6.4 and 13.2 note 7): the leads are real
    // whatever the roster says, so the account is created regardless. No
    // `manpower` row is written for them here — see docs/sales-logins.md for why
    // that has to stay the importer's job.
    //
    // Which sentence gets printed matters. "23 reps the roster has not caught up
    // with" is a list to chase; "the roster is empty" is one sheet to import.
    // Saying the first when the truth is the second sends an admin looking for
    // two hundred missing people.
    console.log(
      report.rosterRows === 0
        ? `\nThe Manpower roster is empty, so all ${report.offRoster} account(s) created are off-roster.` +
            '\nCommit a workbook carrying the Manpower sheet to populate it.'
        : `\n${report.offRoster} of the accounts created belong to codes absent from the Manpower roster` +
            ` (${report.rosterRows} rows).\nThey own real leads, so they are provisioned anyway. Import an up-to-date Manpower sheet to clear this.`,
    );
  }

  if (report.skippedExisting.length > 0) {
    console.log('\nAlready provisioned — password left untouched:');
    for (const row of report.skippedExisting) console.log(`  ${pad(row.smCode, 12)}  ${row.email}`);
  }

  if (report.refused.length > 0) {
    console.log('\nREFUSED — no account was created for these:');
    for (const row of report.refused) console.log(`  ${pad(row.smCode, 12)}  ${row.reason}`);
  }

  const baseUrl = process.env.BETTER_AUTH_URL?.replace(/\/+$/, '');
  console.log(`\nSign in at ${baseUrl ? `${baseUrl}/login` : '(BETTER_AUTH_URL is not set)'}`);

  // Zero even when codes were refused. A refusal here is a standing condition no
  // rerun can clear — a hyphenated code stays hyphenated — and a permanently
  // non-zero exit is one people learn to ignore. The REFUSED block above is the
  // signal.
  return 0;
}

/**
 * True only when this file is the process entry point.
 *
 * Tests import this module for the selection and email helpers; an unguarded
 * call to main() would have them provisioning against whatever database
 * .env.local points at.
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
  // buffered — which here is the only copy of every password.
  main(process.argv.slice(2))
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
