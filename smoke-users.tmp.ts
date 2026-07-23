/* Scratch-only: provisions and removes two throwaway accounts in the dev DB
   so the login + guard flow can be exercised against a running server. */
import { config } from 'dotenv';
config({ path: '.env.local' });

const ADMIN = 'smoke-admin@example.test';
const SALES = 'smoke-sales@example.test';
const PASSWORD = 'smoke-password-1234';

async function main() {
  const mode = process.argv[2];
  const { db } = await import('@/db/client');
  const { user } = await import('@/db/schema');
  const { inArray } = await import('drizzle-orm');

  if (mode === 'create') {
    const { createUserAccount } = await import('@/lib/auth/provision');
    await db.delete(user).where(inArray(user.email, [ADMIN, SALES]));
    await createUserAccount({
      name: 'Smoke Admin',
      email: ADMIN,
      password: PASSWORD,
      role: 'admin',
    });
    await createUserAccount({
      name: 'Smoke Sales',
      email: SALES,
      password: PASSWORD,
      role: 'sales',
      smId: 'ICCSP90766',
    });
    console.log('created');
  } else {
    const deleted = await db.delete(user).where(inArray(user.email, [ADMIN, SALES])).returning();
    console.log('deleted', deleted.length);
  }

  const { pool } = await import('@/db/client');
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
