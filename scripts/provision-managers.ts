/**
 * Gives every team leader and area manager the Manpower sheet names a login.
 *
 *   npx tsx scripts/provision-managers.ts --dry-run
 *   npx tsx scripts/provision-managers.ts
 *   npx tsx scripts/provision-managers.ts --password 'potato1234!!'
 *
 * ROSTER-driven, where sales provisioning is data-driven, and the difference is
 * deliberate. A rep gets an account once they own real records; a manager needs
 * one the moment the roster names them as somebody's approver, which is BEFORE
 * any request has reached them. Waiting for usage would mean the first mapping
 * correction of the month opens a step that resolves to nobody.
 *
 * Idempotent on the code, like every other provisioning path here: a manager who
 * already has an account is skipped, never reset. A rerun after the next import
 * provisions only whoever the sheet has since introduced.
 *
 * Module load order matters for the reason spelled out at the top of
 * scripts/setup-admin.ts: src/lib/env.ts validates process.env at import time and
 * everything touching the database reaches it transitively, so those imports are
 * dynamic and happen after `config()`.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

// Shared with the worklist and with bulk provisioning — see the note in
// src/lib/roster/placeholders.ts on why this list must not be restated per
// caller. It matters more on this rung than on a rep's: a placeholder manager
// account would APPROVE things.
import { isPlaceholderCode, PLACEHOLDER_REASON } from '@/lib/roster/placeholders';

/** No l/I/1 and no O/0 — these are read off a printed table and typed by hand. */
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

type Manager = { kind: 'tl' | 'acm'; code: string; name: string | null; reports: number };

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

async function main(argv: string[]): Promise<number> {
  const dryRun = argv.includes('--dry-run');
  const shared = flag(argv, 'password');

  if (shared && shared.length < 12) {
    // Better Auth is configured with minPasswordLength 12 and would reject this
    // one account at a time, halfway through the run.
    console.error('A shared password must be at least 12 characters.');
    return 1;
  }

  const { pool } = await import('@/db/client');
  const { createUserAccount } = await import('@/lib/auth/provision');
  const { writeAudit } = await import('@/lib/audit/log');
  const { listRoster } = await import('@/lib/users/queries');
  const { emailForRosterEntry } = await import('@/lib/roster/entries');

  /**
   * The same worklist the admin screen shows, filtered to the two manager rungs.
   *
   * Read through `listRoster` rather than re-derived in SQL here. This script
   * used to carry its own definition of "who is a manager" — every non-null
   * `tl_id` and `ccm_id`, counting a manager's own row as one of their reports —
   * which quietly disagreed with the screen: it offered accounts for codes that
   * name nobody but themselves, `DIY` and `300N000001` among them. One
   * definition, in src/lib/roster/entries.ts, or the CLI and the UI provision
   * different sets of people from the same sheet.
   *
   * It reads the EFFECTIVE hierarchy for the same reason the screen does: a code
   * an admin has overridden a rep onto is the code that approves for them now,
   * and provisioning the sheet's version instead would leave the real approver
   * without a login.
   */
  const roster = await listRoster();
  const managers: Array<Manager & { heldBy: string | null }> = roster
    .filter((entry) => entry.rung !== 'sales')
    .map((entry) => ({
      kind: entry.rung as 'tl' | 'acm',
      code: entry.code,
      name: entry.name,
      reports: entry.reports,
      heldBy: entry.accountEmail,
    }));

  if (managers.length === 0) {
    console.error(
      'The Manpower roster names no team leaders or area managers. Import a workbook containing a Manpower sheet first.',
    );
    return 1;
  }

  const created: Array<{ kind: string; code: string; email: string; password: string; reports: number }> = [];
  const skipped: Array<{ code: string; email: string }> = [];

  const refused: Array<{ code: string; reason: string }> = [];

  for (const manager of managers) {
    // `listRoster` already drops these, so this is the second belt rather than
    // the gate. It matters more on this rung than on a rep's: a placeholder
    // manager account would APPROVE things.
    if (isPlaceholderCode(manager.code)) {
      refused.push({ code: manager.code, reason: PLACEHOLDER_REASON });
      continue;
    }

    if (manager.heldBy) {
      skipped.push({ code: manager.code, email: manager.heldBy });
      continue;
    }

    const email = emailForRosterEntry(manager.kind, manager.code);
    const password = shared ?? generatePassword();

    if (dryRun) {
      created.push({ ...manager, email, password: '(dry run)' });
      continue;
    }

    try {
      const account = await createUserAccount({
        name: manager.name?.trim() || manager.code,
        email,
        password,
        role: manager.kind,
        tlCode: manager.kind === 'tl' ? manager.code : null,
        acmCode: manager.kind === 'acm' ? manager.code : null,
      });

      await writeAudit({
        // No session behind a CLI run, so no actor. The row is still the only
        // durable evidence the account was machine-provisioned — the password is
        // printed once and stored nowhere.
        actor: null,
        action: 'USER_CREATE',
        entityType: 'user',
        entityId: account.id,
        after: { email, role: manager.kind, code: manager.code },
        metadata: { via: 'provision-managers', reports: manager.reports, sharedPassword: Boolean(shared) },
      });

      created.push({ ...manager, email, password, reports: manager.reports });
    } catch (error) {
      console.error(`  ! ${manager.code}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log('');
  console.log(dryRun ? '  DRY RUN — nothing was written' : '  Accounts created');
  console.log('');
  console.log('  ROLE  CODE          REPS  EMAIL                              PASSWORD');
  for (const row of created) {
    console.log(
      `  ${row.kind.padEnd(4)}  ${row.code.padEnd(12)}  ${String(row.reports).padStart(4)}  ${row.email.padEnd(34)} ${row.password}`,
    );
  }

  for (const row of refused) {
    console.log(`  - ${row.code.padEnd(12)} refused — ${row.reason}`);
  }

  console.log('');
  console.log(
    `  ${created.length} created, ${skipped.length} already had an account, ${refused.length} refused.`,
  );
  if (!dryRun && created.length > 0 && !shared) {
    console.log('  The passwords are shown once and are not recoverable. Copy this table now.');
  }
  console.log('');

  await pool.end();
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    const { pool } = await import('@/db/client');
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
