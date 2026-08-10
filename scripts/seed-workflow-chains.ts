/**
 * Seeds the approval chains every correction category routes through.
 *
 * Not optional and not sample data: `materializeStages` refuses a submission
 * whose chain does not exist, so a deployment without this has a correction form
 * that fails on submit for every category. It belongs beside `db:migrate` in any
 * environment bring-up.
 *
 * Idempotent by `chain_key`. A chain that already exists is left exactly as it
 * is, including any stages an admin has since added or reordered — re-running
 * this must never quietly undo somebody's configuration, which is the whole
 * reason it creates rather than upserts.
 *
 *   npx tsx scripts/seed-workflow-chains.ts
 *   npx tsx scripts/seed-workflow-chains.ts --bootstrap   # today's flat V1 → approver
 *
 * Module load order matters for the reason spelled out at the top of
 * scripts/setup-admin.ts: src/lib/env.ts validates process.env at import time,
 * and everything touching the database reaches it transitively, so those imports
 * are dynamic and happen after `config()` below.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

async function main(argv: string[]): Promise<number> {
  const bootstrap = argv.includes('--bootstrap');

  const { db, pool } = await import('@/db/client');
  const { CHAIN_KEYS, CHAIN_LABELS, BOOTSTRAP_STAGES, ensureChain, getChain } = await import(
    '@/lib/workflows/chains'
  );
  const { DESIGNED_CHAINS } = await import('@/lib/workflows/routing');

  const created: string[] = [];
  const skipped: string[] = [];

  await db.transaction(async (tx) => {
    for (const chainKey of CHAIN_KEYS) {
      const stages = bootstrap ? BOOTSTRAP_STAGES : DESIGNED_CHAINS[chainKey];
      const result = await ensureChain(tx, chainKey, stages);
      (result.created ? created : skipped).push(chainKey);
    }
  });

  console.log('');
  console.log(bootstrap ? '  Bootstrap chains (verifier → approver)' : '  Designed chains');
  console.log('');

  for (const chainKey of CHAIN_KEYS) {
    const chain = await getChain(chainKey);
    const steps = chain?.stages.map((s) => s.stageKey).join(' → ') ?? '(none)';
    const mark = created.includes(chainKey) ? '+' : '·';
    console.log(`  ${mark} ${CHAIN_LABELS[chainKey].padEnd(32)} ${steps}`);
  }

  console.log('');
  console.log(`  ${created.length} created, ${skipped.length} already present and left untouched.`);
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
