import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from 'dotenv';
import { Pool } from 'pg';

config({ path: '.env.local' });

const dir = join(process.cwd(), 'drizzle', 'custom');

async function main() {
  const useTest = process.argv.includes('--test');
  const url = useTest ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL resolved');

  const pool = new Pool({ connectionString: url });
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await pool.query(sql);
    console.log(`applied ${file}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
