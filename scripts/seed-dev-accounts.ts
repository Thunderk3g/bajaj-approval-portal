/**
 * One account per role, all on the same password, for walking the flows locally.
 *
 * DEVELOPMENT ONLY. It creates six accounts that share one well-known password
 * and refuses to run against a database that already holds users, so it cannot
 * be pointed at a real deployment and quietly weaken it.
 *
 *   npx tsx scripts/seed-dev-accounts.ts
 *   npx tsx scripts/seed-dev-accounts.ts --force   # allow a non-empty user table
 *
 * The hierarchy below is deliberately consistent — SM001 reports to TL001, TL001
 * sits under CCM001 — because the mapping chains resolve their TL and ACM rungs
 * through exactly that shape. Accounts alone are not enough: the roster rows are
 * what place a rep under a manager, so this writes those too. A real deployment
 * gets both from the Manpower sheet instead.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

/**
 * Better Auth is configured with `minPasswordLength: 12`, so the memorable
 * short password everyone asks for is rejected before it reaches the hasher.
 * Padded rather than lowering the floor: the minimum protects every real
 * deployment, and weakening it so a demo can use ten characters would be trading
 * the wrong thing.
 */
const DEV_PASSWORD = 'potato1234!!';

const ACCOUNTS = [
  { role: 'admin', email: 'admin@bajajlife.com', name: 'Demo Administrator' },
  { role: 'approver', email: 'approver@bajajlife.com', name: 'Demo Approver' },
  { role: 'verifier', email: 'verifier@bajajlife.com', name: 'Demo Verifier' },
  { role: 'acm', email: 'acm@bajajlife.com', name: 'Demo Area Manager', acmCode: 'CCM001' },
  { role: 'tl', email: 'tl@bajajlife.com', name: 'Demo Team Leader', tlCode: 'TL001' },
  { role: 'sales', email: 'sm@bajajlife.com', name: 'Demo Sales Manager', smId: 'SM001' },
] as const;

async function main(argv: string[]): Promise<number> {
  const force = argv.includes('--force');

  const { db, pool } = await import('@/db/client');
  const { user, manpower } = await import('@/db/schema');
  const { count } = await import('drizzle-orm');
  const { createUserAccount } = await import('@/lib/auth/provision');

  const [existing] = await db.select({ value: count() }).from(user);
  if ((existing?.value ?? 0) > 0 && !force) {
    console.error(
      `Refusing to run: the user table already holds ${existing.value} account(s).\n` +
        'This script creates six accounts sharing one well-known password and is for a\n' +
        'fresh local database only. Pass --force if you are certain.',
    );
    return 1;
  }

  for (const spec of ACCOUNTS) {
    await createUserAccount({
      name: spec.name,
      email: spec.email,
      password: DEV_PASSWORD,
      role: spec.role,
      smId: 'smId' in spec ? spec.smId : null,
      tlCode: 'tlCode' in spec ? spec.tlCode : null,
      acmCode: 'acmCode' in spec ? spec.acmCode : null,
    });
  }

  // The roster row is what actually places the rep. Without it `resolveApprover`
  // answers NO_CODE for both manager rungs and every mapping chain skips them,
  // which looks exactly like the accounts not working.
  await db
    .insert(manpower)
    .values({
      smId: 'SM001',
      smName: 'Demo Sales Manager',
      tlId: 'TL001',
      tlName: 'Demo Team Leader',
      ccmId: 'CCM001',
      ccmName: 'Demo Area Manager',
      location: 'Pune',
      isOrphan: false,
    })
    .onConflictDoNothing({ target: manpower.smId });

  console.log('');
  console.log(`  Six accounts created. Password for all of them: ${DEV_PASSWORD}`);
  console.log('');
  for (const spec of ACCOUNTS) {
    const scope =
      'smId' in spec ? spec.smId : 'tlCode' in spec ? spec.tlCode : 'acmCode' in spec ? spec.acmCode : '—';
    console.log(`  ${spec.role.padEnd(9)} ${spec.email.padEnd(28)} ${scope}`);
  }
  console.log('');
  console.log('  Hierarchy: SM001 → TL001 → CCM001 (roster row written).');
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
