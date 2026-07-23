import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

const connectionString =
  process.env.NODE_ENV === 'test'
    ? (process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL!)
    : process.env.DATABASE_URL!;

const globalForDb = globalThis as unknown as { __sdrpPool?: Pool };

const isDev = process.env.NODE_ENV === 'development';

// The globalThis cache stops Next.js hot reload from opening a new pool on
// every edit. It is scoped to development deliberately: every test file calls
// pool.end() in afterAll, and a pool shared across files through globalThis
// would leave the second file with a closed pool.
export const pool = (isDev && globalForDb.__sdrpPool) || new Pool({ connectionString, max: 10 });

if (isDev) globalForDb.__sdrpPool = pool;

export const db = drizzle(pool, { schema });
